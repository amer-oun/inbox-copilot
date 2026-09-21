import { AlertTriangle, Paperclip } from "lucide-react";
import type { MessageDto } from "@inbox-copilot/shared";
import { Badge } from "../ui/badge";
import { Avatar } from "../shell/Avatar";
import { cn } from "../../lib/utils";
import { MessageBody } from "./MessageBody";
import { TranslateControl } from "./TranslateControl";

/**
 * One message: its envelope, its attachments, and its body.
 *
 * The header is a server component; only the body needs the client, so the
 * addresses and attachment list are in the server-rendered HTML.
 *
 * The user's own messages are marked by an indented, tinted envelope rather than
 * by being dimmed. Dimming implied "less important" about text the reader wrote
 * themselves, when what is actually being said is "this side of the conversation
 * is yours" — and a greyed-out message in a thread reads as failed or deleted.
 */

function formatSentAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentList({ attachments }: { attachments: MessageDto["attachments"] }) {
  // Inline images are part of the body, not a file the reader chose to receive.
  const files = attachments.filter((attachment) => !attachment.isInline);
  if (files.length === 0) return null;

  return (
    <ul className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
      {files.map((file) => (
        <li
          key={file.id}
          className={cn(
            "flex items-center gap-2 rounded-[var(--radius-control)] border px-2.5 py-1.5 text-xs",
            file.riskFlag === null
              ? "border-line bg-panel"
              : "border-danger-line bg-danger-soft",
          )}
        >
          {file.riskFlag === null ? (
            <Paperclip aria-hidden="true" className="size-3.5 text-muted" />
          ) : (
            // The flag is deterministic (extension-based, from the sync engine), so
            // it is shown plainly rather than as a score.
            <AlertTriangle aria-hidden="true" className="size-3.5 text-danger" />
          )}
          <span className="max-w-[14rem] truncate font-medium text-ink">
            {file.filename}
          </span>
          <span className="tabular-nums text-muted">{formatBytes(file.sizeBytes)}</span>
          {file.riskFlag !== null && (
            <Badge tone="danger" size="sm" className="ml-0.5">
              {file.riskFlag}
            </Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface MessageCardProps {
  message: MessageDto;
  /** The user's default translation language, from the thread read. */
  defaultTranslationLang?: string | null;
}

export function MessageCard({
  message,
  defaultTranslationLang = null,
}: MessageCardProps) {
  const sender = message.from.name ?? message.from.email;

  return (
    <article
      className={cn(
        "overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface",
        "shadow-raise",
        message.isOutbound && "sm:ml-8",
      )}
    >
      <header
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3",
          message.isOutbound && "bg-panel/70",
        )}
      >
        <Avatar
          name={message.from.name}
          email={message.from.email}
          className="size-7 text-[0.625rem]"
        />
        <span className="text-sm font-semibold text-ink">{sender}</span>
        {message.from.name !== null && (
          <span className="truncate text-xs text-muted">
            &lt;{message.from.email}&gt;
          </span>
        )}
        {message.isOutbound && (
          <Badge tone="neutral" size="sm">
            Sent
          </Badge>
        )}
        <time
          dateTime={message.sentAt}
          className="ml-auto shrink-0 text-xs tabular-nums text-muted"
          title={message.sentAt}
        >
          {formatSentAt(message.sentAt)}
        </time>
        <p className="w-full truncate text-xs text-muted">
          To: {message.to.join(", ") || "(undisclosed recipients)"}
          {message.cc.length > 0 && ` · Cc: ${message.cc.join(", ")}`}
        </p>
      </header>

      <div className="border-t border-line">
        <MessageBody
          html={message.bodyHtmlSanitized}
          text={message.bodyText}
          blockedRemoteImages={message.blockedRemoteImages}
        />
      </div>

      <AttachmentList attachments={message.attachments} />

      {/*
        The language control (§9). Offered on every message with text, including the
        user's own: a thread read in translation should not have one unreadable
        paragraph in the middle of it.
      */}
      {(message.bodyText !== null || message.bodyHtmlSanitized !== null) && (
        <TranslateControl messageId={message.id} defaultLang={defaultTranslationLang} />
      )}
    </article>
  );
}
