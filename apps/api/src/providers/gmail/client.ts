import { google, type gmail_v1 } from "googleapis";
import { NotFoundError, UpstreamError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { mapWithConcurrency, withRetry } from "../../lib/retry.js";
import { acquireGmailQuota, type GmailMethod } from "../../lib/rateLimiter.js";
import { getAccessToken } from "../tokenManager.js";
import { mapThread } from "./map.js";
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

    async sendMessage(_input: OutboundMessage): Promise<never> {
      // Phase 6. Rule 1 says sending is always a separate, user-initiated call, so
      // this deliberately does not exist yet rather than being half-built.
      throw new UpstreamError("Gmail sendMessage is not implemented until phase 6");
    },

    async createDraft(_input: OutboundMessage): Promise<never> {
      throw new UpstreamError("Gmail createDraft is not implemented until phase 6");
    },

    async modifyLabels(): Promise<never> {
      throw new UpstreamError("Gmail modifyLabels is not implemented until phase 6");
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
