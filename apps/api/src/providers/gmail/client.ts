import { google, type gmail_v1 } from "googleapis";
import { NotFoundError, UpstreamError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { mapWithConcurrency, withRetry } from "../../lib/retry.js";
import { acquireGmailQuota, type GmailMethod } from "../../lib/rateLimiter.js";
import { getAccessToken } from "../tokenManager.js";
import { htmlToText } from "../../lib/html.js";
import { mapThread } from "./map.js";
import { buildMimeMessage, encodeMimeForGmail, type MimeMessageInput } from "./mime.js";
import type {
  ListThreadIdsOptions,
  MailProvider,
  MailProviderContext,
  OutboundMessage,
  Page,
  RawChange,
  RawThread,
} from "../mailProvider.js";

/**
 * Gmail implementation of the provider port (§3).
 *
 * `googleapis` is imported here and nowhere else (rule 5). Access tokens come from
 * `getAccessToken(mailAccountId, userId)` before every call — never cached on the
 * instance, so a token that expires mid-backfill is refreshed by the token manager
 * rather than failing the job.
 *
 * Every call also spends its documented quota cost from the mailbox token bucket
 * before firing, and carries the job's AbortSignal so a cancelled backfill stops
 * making requests instead of racing its own retry.
 */

/** Gmail caps `threads.list` at 500; 50 is the backfill batch size from §4. */
const MAX_PAGE_SIZE = 500;

/**
 * In-flight `threads.get` calls per batch. Two, not five: each is 10 quota units, so
 * the ceiling here is a multiplier on the bucket's budget, and the bucket — not this
 * number — is what paces the run.
 */
const THREAD_FETCH_CONCURRENCY = 2;

export function createGmailProvider(context: MailProviderContext): MailProvider {
  const log = logger.child({
    userId: context.userId,
    mailAccountId: context.mailAccountId,
  });

  /**
   * A fresh client per call. The OAuth2Client is a thin credential holder, so this
   * costs nothing measurable, and it means we never hold a stale access token or
   * share one across mailboxes.
   */
  async function api(): Promise<gmail_v1.Gmail> {
    const accessToken = await getAccessToken(context.mailAccountId, context.userId);
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    return google.gmail({ version: "v1", auth });
  }

  /**
   * One place where every Gmail request is paced, authenticated, retried and
   * cancellable. Quota is acquired inside the retry body, so a retried call pays
   * for itself again — it is a second request, and the bucket has to know.
   */
  async function call<T>(
    method: GmailMethod,
    fn: (gmail: gmail_v1.Gmail, requestOptions: { signal?: AbortSignal }) => Promise<T>,
  ): Promise<T> {
    const signal = context.signal;

    return withRetry(
      async () => {
        await acquireGmailQuota(context.mailAccountId, method, signal);
        const gmail = await api();
        return fn(gmail, signal ? { signal } : {});
      },
      {
        label: `gmail.${method}`,
        ...(signal ? { signal } : {}),
      },
    );
  }

  /**
   * The same plumbing without the retry, for requests that must not be repeated.
   * Quota is still spent and the token is still fresh; what is missing is the one
   * thing a send cannot have.
   */
  async function callOnce<T>(
    method: GmailMethod,
    fn: (gmail: gmail_v1.Gmail, requestOptions: { signal?: AbortSignal }) => Promise<T>,
  ): Promise<T> {
    const signal = context.signal;
    await acquireGmailQuota(context.mailAccountId, method, signal);
    const gmail = await api();
    return fn(gmail, signal ? { signal } : {});
  }

  return {
    providerType: "GMAIL",

    async getProfile() {
      const profile = await call("users.getProfile", async (gmail, requestOptions) =>
        gmail.users.getProfile({ userId: "me" }, requestOptions),
      );

      const emailAddress = profile.data.emailAddress;
      if (!emailAddress) {
        throw new UpstreamError("Gmail profile carried no email address");
      }

      return {
        emailAddress: emailAddress.toLowerCase(),
        // Gmail has no separate account id; the address is the stable identifier.
        providerAccountId: emailAddress.toLowerCase(),
        historyId: profile.data.historyId ?? null,
      };
    },

    async listThreadIds(options: ListThreadIdsOptions): Promise<Page<string>> {
      // `after:` takes seconds. Gmail's search granularity is a day, so this is a
      // lower bound, not a filter we can rely on for exactness — the backfill
      // window is deliberately generous rather than precise.
      const query = options.after
        ? `after:${Math.floor(options.after.getTime() / 1000)}`
        : undefined;

      const response = await call("users.threads.list", async (gmail, requestOptions) =>
        gmail.users.threads.list(
          {
            userId: "me",
            maxResults: Math.min(options.limit, MAX_PAGE_SIZE),
            ...(options.pageToken === undefined ? {} : { pageToken: options.pageToken }),
            ...(query === undefined ? {} : { q: query }),
            // Spam and trash are not mail the user is working with, and including
            // them would put phishing bodies in the DB for no benefit yet.
            includeSpamTrash: false,
          },
          requestOptions,
        ),
      );

      const items = (response.data.threads ?? [])
        .map((thread) => thread.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);

      return { items, nextPageToken: response.data.nextPageToken ?? null };
    },

    async getThread(providerThreadId: string): Promise<RawThread> {
      const response = await call("users.threads.get", async (gmail, requestOptions) =>
        gmail.users.threads.get(
          {
            userId: "me",
            id: providerThreadId,
            // `full` gives headers and body without the raw RFC822 blob, which we
            // would only have to re-parse ourselves.
            format: "full",
          },
          requestOptions,
        ),
      );

      return mapThread(response.data, { mailboxAddress: context.emailAddress });
    },

    async getAttachment(providerMessageId: string, attachmentId: string): Promise<Buffer> {
      const response = await call(
        "users.messages.attachments.get",
        async (gmail, requestOptions) =>
          gmail.users.messages.attachments.get(
            {
              userId: "me",
              messageId: providerMessageId,
              id: attachmentId,
            },
            requestOptions,
          ),
      );

      const data = response.data.data;
      if (!data) throw new NotFoundError("Attachment has no content");
      return Buffer.from(data, "base64url");
    },

    /**
     * Incremental sync via `history.list` from `startHistoryId`.
     *
     * Two Gmail specifics drive the shape here:
     *   1. A history id older than roughly a week returns 404 — the mailbox has to
     *      be re-backfilled. That is reported as a typed error, not swallowed.
     *   2. History records are not a diff: the same message can appear as added
     *      and then label-changed within one page, so they are folded per message
     *      with the last write winning.
     */
    async syncDelta(cursor: string | null) {
      if (cursor === null) {
        throw new UpstreamError("Gmail delta sync needs a history id; backfill first");
      }

      const changes = new Map<string, RawChange>();
      let pageToken: string | undefined;
      let newCursor = cursor;

      do {
        const response = await call("users.history.list", async (gmail, requestOptions) =>
          gmail.users.history.list(
            {
              userId: "me",
              startHistoryId: cursor,
              ...(pageToken === undefined ? {} : { pageToken }),
            },
            requestOptions,
          ),
        );

        newCursor = response.data.historyId ?? newCursor;

        for (const record of response.data.history ?? []) {
          foldHistoryRecord(record, changes);
        }

        pageToken = response.data.nextPageToken ?? undefined;
      } while (pageToken !== undefined);

      log.debug({ changes: changes.size, cursor: newCursor }, "gmail delta read");
      return { changes: [...changes.values()], cursor: newCursor };
    },

    /**
     * Sends one message (rule 1: only ever reached from a user-initiated request
     * carrying text the user submitted).
     *
     * **This is the one call in the file that does not retry.** `withRetry` exists
     * because a read that fails can be repeated for free; a send cannot. A 429 or a
     * 502 from Gmail does not tell us whether the message went out — the failure may
     * be on the response path — and a retry that guesses wrong sends the user's mail
     * twice. So this spends its quota, makes exactly one attempt, and reports the
     * failure to the caller, who can show it to the person who pressed the button.
     */
    async sendMessage(input: OutboundMessage) {
      const raw = encodeMimeForGmail(buildMimeMessage(toMime(input, context.emailAddress)));

      const response = await callOnce("users.messages.send", async (gmail, requestOptions) =>
        gmail.users.messages.send(
          {
            userId: "me",
            requestBody: {
              raw,
              /*
               * Gmail's own grouping for this mailbox. It is *not* a substitute for
               * In-Reply-To/References — those are what every other participant's
               * client threads on — and Gmail rejects a threadId whose subject does
               * not match, so the reply subject keeps the parent's.
               */
              ...(input.inReplyTo === undefined
                ? {}
                : { threadId: input.inReplyTo.providerThreadId }),
            },
          },
          requestOptions,
        ),
      );

      const providerMessageId = response.data.id;
      const providerThreadId = response.data.threadId;

      if (!providerMessageId || !providerThreadId) {
        // The mail is gone whatever this says, so it is an upstream oddity rather
        // than a failure to retry — and the log line is the only record of the ids.
        throw new UpstreamError("Gmail accepted the send but returned no ids");
      }

      log.info({ providerMessageId, providerThreadId }, "message sent");
      return { providerMessageId, providerThreadId };
    },

    /**
     * Saves a draft in the user's mailbox.
     *
     * This one does retry: a duplicated draft is visible, editable and deletable,
     * which a duplicated *send* is not.
     */
    async createDraft(input: OutboundMessage) {
      const raw = encodeMimeForGmail(buildMimeMessage(toMime(input, context.emailAddress)));

      const response = await call("users.drafts.create", async (gmail, requestOptions) =>
        gmail.users.drafts.create(
          {
            userId: "me",
            requestBody: {
              message: {
                raw,
                ...(input.inReplyTo === undefined
                  ? {}
                  : { threadId: input.inReplyTo.providerThreadId }),
              },
            },
          },
          requestOptions,
        ),
      );

      const draftId = response.data.id;
      if (!draftId) throw new UpstreamError("Gmail created a draft with no id");

      log.info({ draftId }, "draft created");
      return { draftId };
    },

    async modifyLabels(): Promise<never> {
      // Marking read, archiving and labelling are UI actions; nothing in phase 6
      // needs them, and a half-built version would be a write path with no caller.
      throw new UpstreamError("Gmail modifyLabels is not implemented yet");
    },

    async startWatch(): Promise<never> {
      throw new UpstreamError("Gmail watch is not implemented until phase 7");
    },

    async stopWatch(): Promise<never> {
      throw new UpstreamError("Gmail watch is not implemented until phase 7");
    },
  };
}

/**
 * The port's outbound shape as MIME input.
 *
 * `from` is the mailbox's own address, taken from the provider context and never
 * from the caller: Gmail would reject a foreign From anyway, and accepting one here
 * would make "send as somebody else" an argument rather than an impossibility.
 *
 * The plain-text part is derived from the HTML when the caller did not supply one,
 * because a text/html-only message is both a spam signal and unreadable in a client
 * that prefers text.
 */
function toMime(input: OutboundMessage, mailboxAddress: string): MimeMessageInput {
  return {
    from: { email: mailboxAddress },
    to: input.to,
    ...(input.cc === undefined ? {} : { cc: input.cc }),
    ...(input.bcc === undefined ? {} : { bcc: input.bcc }),
    subject: input.subject,
    html: input.bodyHtml,
    text: input.bodyText ?? htmlToText(input.bodyHtml).trim(),
    ...(input.inReplyTo === undefined
      ? {}
      : {
          inReplyTo: input.inReplyTo.internetMessageId,
          /*
           * The chain is emitted as the caller built it, with the parent appended only
           * if the caller did not already do so.
           *
           * Both layers used to append it, and a real self-addressed send showed the
           * result: `References: <parent> <parent>`. Harmless to a client that
           * deduplicates, wrong on the wire, and on a long thread it would fill half
           * the (bounded) chain with duplicates of the ids that matter.
           */
          references: appendParent(
            input.inReplyTo.references ?? [],
            input.inReplyTo.internetMessageId,
          ),
        }),
  };
}

/**
 * The `References` chain to emit: the caller's, ending in the parent exactly once.
 *
 * Idempotent on purpose, because two callers disagree about whose job the last entry
 * is: `services/send.ts` builds the full chain from the stored header, while a caller
 * that only has the parent's Message-ID passes the chain without it.
 */
function appendParent(
  references: readonly string[],
  parentMessageId: string,
): string[] {
  return references.at(-1) === parentMessageId
    ? [...references]
    : [...references, parentMessageId];
}

/**
 * Folds one `history.list` record into the change map.
 *
 * Ordering matters: Gmail guarantees records are in increasing history order, so a
 * later delete must overwrite an earlier upsert for the same message.
 */
function foldHistoryRecord(
  record: gmail_v1.Schema$History,
  changes: Map<string, RawChange>,
): void {
  for (const added of record.messagesAdded ?? []) {
    const ids = idsOf(added.message);
    if (ids) changes.set(ids.providerMessageId, { kind: "upserted", ...ids });
  }

  for (const deleted of record.messagesDeleted ?? []) {
    const ids = idsOf(deleted.message);
    if (ids) changes.set(ids.providerMessageId, { kind: "deleted", ...ids });
  }

  for (const labelChange of record.labelsAdded ?? []) {
    const ids = idsOf(labelChange.message);
    if (!ids) continue;
    mergeLabelChange(changes, ids, labelChange.labelIds ?? [], []);
  }

  for (const labelChange of record.labelsRemoved ?? []) {
    const ids = idsOf(labelChange.message);
    if (!ids) continue;
    mergeLabelChange(changes, ids, [], labelChange.labelIds ?? []);
  }
}

function idsOf(
  message: gmail_v1.Schema$Message | undefined,
): { providerMessageId: string; providerThreadId: string } | null {
  if (!message?.id || !message.threadId) return null;
  return { providerMessageId: message.id, providerThreadId: message.threadId };
}

function mergeLabelChange(
  changes: Map<string, RawChange>,
  ids: { providerMessageId: string; providerThreadId: string },
  added: string[],
  removed: string[],
): void {
  const existing = changes.get(ids.providerMessageId);

  // A label change on a message we are already fetching in full adds nothing:
  // the fetch brings the current labels with it.
  if (existing && existing.kind !== "labelsChanged") return;

  changes.set(ids.providerMessageId, {
    kind: "labelsChanged",
    ...ids,
    labelsAdded: [...new Set([...(existing?.kind === "labelsChanged" ? existing.labelsAdded : []), ...added])],
    labelsRemoved: [...new Set([...(existing?.kind === "labelsChanged" ? existing.labelsRemoved : []), ...removed])],
  });
}

/**
 * Fetches a batch of threads with the concurrency cap. Exposed separately from the
 * port because batching is a sync-engine concern, not part of the provider
 * contract — every provider would implement it identically.
 */
export async function fetchThreads(
  provider: MailProvider,
  providerThreadIds: readonly string[],
  signal?: AbortSignal,
): Promise<RawThread[]> {
  return mapWithConcurrency(
    providerThreadIds,
    THREAD_FETCH_CONCURRENCY,
    async (id) => provider.getThread(id),
    signal,
  );
}
