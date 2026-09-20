import { AlertTriangle, Paperclip } from "lucide-react";
import type { MessageDto } from "@inbox-copilot/shared";
import { Badge } from "../ui/badge";
import { cn } from "../../lib/utils";
import { MessageBody } from "./MessageBody";
import { TranslateControl } from "./TranslateControl";

/**
 * One message: its envelope, its attachments, and its body.
 *
 * The header is a server component; only the body needs the client, so the
 * addresses and attachment list are in the server-rendered HTML.
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
    <ul className="flex flex-wrap gap-2 border-t border-border-subtle px-4 py-3">
      {files.map((file) => (
        <li
          key={file.id}
          className="flex items-center gap-2 rounded-lg border border-border-subtle bg-canvas px-2.5 py-1.5 text-xs"
        >
          {file.riskFlag === null ? (
            <Paperclip aria-hidden="true" className="size-3.5 text-muted" />
          ) : (
            // The flag is deterministic (extension-based, from the sync engine), so
            // it is shown plainly rather than as a score.
            <AlertTriangle aria-hidden="true" className="size-3.5 text-danger" />
          )}
          <span className="max-w-[14rem] truncate text-ink">{file.filename}</span>
          <span className="text-muted">{formatBytes(file.sizeBytes)}</span>
          {file.riskFlag !== null && (
            <Badge tone="danger" className="ml-1">
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
        "overflow-hidden rounded-card border bg-surface",
        // The user's own messages are visually secondary: they already know them.
        message.isOutbound ? "border-border-subtle/70 bg-canvas" : "border-border-subtle",
      )}
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-3">
        <span className="text-sm font-semibold text-ink">{sender}</span>
        {message.from.name !== null && (
          <span className="text-xs text-muted">&lt;{message.from.email}&gt;</span>
        )}
        {message.isOutbound && (
          <Badge tone="neutral" className="ml-1">
            Sent
          </Badge>
        )}
        <time
          dateTime={message.sentAt}
          className="ml-auto shrink-0 text-xs text-muted"
          title={message.sentAt}
        >
          {formatSentAt(message.sentAt)}
        </time>
        <p className="w-full truncate text-xs text-muted">
          To: {message.to.join(", ") || "(undisclosed recipients)"}
          {message.cc.length > 0 && ` · Cc: ${message.cc.join(", ")}`}
        </p>
      </header>

      <div className="border-t border-border-subtle">
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
