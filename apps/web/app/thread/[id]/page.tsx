import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Reply } from "lucide-react";
import { threadDetailSchema } from "@inbox-copilot/shared";
import { ApiError, apiFetch } from "../../../lib/apiClient";
import { requireSession } from "../../../lib/session";
import { Badge } from "../../../components/ui/badge";
import { SummaryCard } from "../../../components/thread/SummaryCard";
import { MessageCard } from "../../../components/thread/MessageCard";
import { ReplyComposer } from "../../../components/thread/ReplyComposer";
import { ThreatBanner } from "../../../components/thread/ThreatBanner";

/**
 * One thread: summary first, then the conversation oldest-first.
 *
 * A server component. Only the message bodies need the client (remote images and
 * frame height), so everything else — envelopes, summary, attachments — is in the
 * HTML the server sends.
 */

interface ThreadPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: ThreadPageProps) {
  const { id } = await params;
  return { title: `Thread · Inbox Copilot`, other: { "thread-id": id } };
}

export default async function ThreadPage({ params }: ThreadPageProps) {
  const { id } = await params;
  const session = await requireSession(`/thread/${id}`);

  let thread;
  try {
    thread = await apiFetch(session.user.id, `/threads/${id}`, threadDetailSchema);
  } catch (error) {
    // A thread belonging to someone else is a 404 from the API (the tenancy filter
    // makes it not exist), and it stays a 404 here — no "forbidden" that would
    // confirm the id is real.
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-4 pb-16 pt-6">
      <Link
        href="/inbox/all"
        className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Inbox
      </Link>

      <header className="mt-4">
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          {thread.subject ?? "(no subject)"}
        </h1>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>
            {`${thread.messageCount} message${thread.messageCount === 1 ? "" : "s"}`}
          </span>
          {thread.category !== null && <Badge tone="neutral">{thread.category}</Badge>}
          {thread.priority !== null && (
            <Badge tone={thread.priority === "URGENT" ? "danger" : "info"}>
              {thread.priority}
            </Badge>
          )}
          {thread.needsReply && (
            <span className="inline-flex items-center gap-1">
              <Reply aria-hidden="true" className="size-3.5" />
              Needs a reply
            </span>
          )}
          {thread.language !== null && <span>{thread.language}</span>}
        </div>

        {/*
          The banner is a client component because of the appeal control, and it is
          handed the whole assessment rather than a level: the reasons are the product
          (§6), and a banner that only knew `threatLevel` could not show them.
        */}
        {thread.threat !== null && (
          <div className="mt-3">
            <ThreatBanner threat={thread.threat} />
          </div>
        )}

        <p className="mt-3 truncate text-xs text-muted">
          {thread.participants.map((person) => person.name ?? person.email).join(", ")}
        </p>
      </header>

      {thread.summary !== null && (
        <div className="mt-5">
          <SummaryCard summary={thread.summary} />
        </div>
      )}

      {/*
        Oldest first, which is how the API returns them: a conversation read in the
        order it happened. Each body is sandboxed independently.
      */}
      <div className="mt-5 space-y-4">
        {thread.messages.map((message) => (
          <MessageCard
            key={message.id}
            message={message}
            defaultTranslationLang={thread.defaultTranslationLang}
          />
        ))}
      </div>

      {/*
        The composer goes last, where a reply belongs in a conversation. The recipient
        is handed down from the API rather than derived here: the address on the send
        button must be the address the send path will actually use.
      */}
      <div className="mt-5">
        <ReplyComposer threadId={thread.id} recipients={thread.replyRecipients} />
      </div>
    </main>
  );
}
