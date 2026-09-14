import type { MailProviderType } from "@inbox-copilot/shared";

/**
 * The provider port (ARCHITECTURE §3). Every feature codes against this; adding a
 * third provider later means one new folder under `providers/` and no changes
 * upstream. Provider SDKs are imported only inside those folders (rule 5).
 *
 * The shapes below are the *raw* normalized form — what a provider hands back
 * once `map.ts` has flattened its payload. Persistence is the sync service's job,
 * so nothing here touches Prisma.
 */

export interface Page<T> {
  items: T[];
  /** Opaque provider cursor; `null` when the last page has been read. */
  nextPageToken: string | null;
}

/** One participant on a message, as parsed from an address header. */
export interface RawAddress {
  name?: string;
  email: string;
}

/**
 * SPF/DKIM/DMARC verdicts parsed out of `Authentication-Results`.
 *
 * Phase 9 decides what to do with these; phase 2 only has to record them
 * faithfully, including "the header did not say", which is `null` rather than a
 * guess — absence of a pass is not a fail.
 */
export type AuthVerdict =
  | "pass"
  | "fail"
  | "softfail"
  | "neutral"
  | "none"
  | "temperror"
  | "permerror";

export interface RawAuthResults {
  spf: AuthVerdict | null;
  dkim: AuthVerdict | null;
  dmarc: AuthVerdict | null;
  /** The envelope sender, when the header disclosed it. */
  returnPath: string | null;
  /** True when the From display name contains an address that is not the From address. */
  displayNameMismatch: boolean;
}

export interface RawAttachment {
  providerAttachmentId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isInline: boolean;
}

export interface RawMessage {
  providerMessageId: string;
  providerThreadId: string;
  /** RFC 5322 Message-ID — what threading on send depends on. */
  internetMessageId: string | null;
  from: RawAddress;
  to: RawAddress[];
  cc: RawAddress[];
  bcc: RawAddress[];
  replyTo: RawAddress | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  snippet: string | null;
  sentAt: Date;
  isRead: boolean;
  /** Sent by the mailbox owner — decided by comparing From to the mailbox address. */
  isOutbound: boolean;
  isDraft: boolean;
  hasAttachments: boolean;
  headers: Record<string, string>;
  authResults: RawAuthResults;
  /** sha256 of the normalized plain-text body: the AI cache key (rule 7). */
  contentHash: string;
  attachments: RawAttachment[];
  /** Provider-native labels, kept for round-tripping and debugging. */
  labels: string[];
}

export interface RawThread {
  providerThreadId: string;
  /** Provider history pointer at read time, when it exposes one. */
  historyId: string | null;
  messages: RawMessage[];
}

/**
 * One incremental change. `deleted` carries no message body — the row is gone
 * provider-side, so all we can do is mark ours.
 */
export type RawChange =
  | { kind: "upserted"; providerThreadId: string; providerMessageId: string }
  | { kind: "deleted"; providerThreadId: string; providerMessageId: string }
  | {
      kind: "labelsChanged";
      providerThreadId: string;
      providerMessageId: string;
      labelsAdded: string[];
      labelsRemoved: string[];
    };

export interface ListThreadIdsOptions {
  pageToken?: string;
  limit: number;
  /** Only threads with activity at or after this instant. */
  after?: Date;
}

export interface OutboundMessage {
  to: RawAddress[];
  cc?: RawAddress[];
  bcc?: RawAddress[];
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  /**
   * Set when replying.
   *
   * `references` is the `References` chain to emit, oldest first. A caller that
   * already ends it with the parent's Message-ID (as `services/send.ts` does) gets it
   * emitted as-is; one that omits the parent has it appended. Carrying only
   * `In-Reply-To` threads correctly in some clients and not others, which is why both
   * headers are sent (§ providers/gmail/mime.ts).
   */
  inReplyTo?: {
    providerThreadId: string;
    internetMessageId: string;
    references?: readonly string[];
  };
}

export interface MailProvider {
  readonly providerType: MailProviderType;

  // identity
  getProfile(): Promise<{
    emailAddress: string;
    providerAccountId: string;
    /** Provider's current history pointer — the starting cursor for delta sync. */
    historyId: string | null;
  }>;

  // read
  listThreadIds(options: ListThreadIdsOptions): Promise<Page<string>>;
  getThread(providerThreadId: string): Promise<RawThread>;
  getAttachment(providerMessageId: string, attachmentId: string): Promise<Buffer>;

  // incremental
  syncDelta(cursor: string | null): Promise<{ changes: RawChange[]; cursor: string }>;

  // write — phase 6
  sendMessage(
    input: OutboundMessage,
  ): Promise<{ providerMessageId: string; providerThreadId: string }>;
  createDraft(input: OutboundMessage): Promise<{ draftId: string }>;
  modifyLabels(
    providerThreadId: string,
    add: string[],
    remove: string[],
  ): Promise<void>;

  // push — phase 7
  startWatch(): Promise<{ expiresAt: Date; cursor: string }>;
  stopWatch(): Promise<void>;
}

/** Identifies the mailbox a provider instance is bound to. */
export interface MailProviderContext {
  mailAccountId: string;
  userId: string;
  /** The mailbox's own address — how `isOutbound` is decided. */
  emailAddress: string;
  /**
   * Cancels in-flight requests. A provider instance belongs to one unit of work (a
   * backfill attempt), so when that work is abandoned its requests must stop rather
   * than continue alongside the next attempt.
   */
  signal?: AbortSignal;
}
