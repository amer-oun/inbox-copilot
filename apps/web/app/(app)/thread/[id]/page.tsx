import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Reply } from "lucide-react";
import { threadDetailSchema } from "@inbox-copilot/shared";
import { ApiError, apiFetch, isApiUnavailable } from "../../../../lib/apiClient";
import { requireViewer } from "../../../../lib/viewer";
import { StartingUp } from "../../../../components/shell/StartingUp";
import { Badge } from "../../../../components/ui/badge";
import { PageBody, PageHeader } from "../../../../components/shell/PageHeader";
import { SummaryCard } from "../../../../components/thread/SummaryCard";
import { MessageCard } from "../../../../components/thread/MessageCard";
import { ReplyComposer } from "../../../../components/thread/ReplyComposer";
import { ThreatBanner } from "../../../../components/thread/ThreatBanner";

/**
 * One thread: summary first, then the conversation oldest-first.
 *
 * A server component. Only the message bodies need the client (remote images and
 * frame height), so everything else — envelopes, summary, attachments — is in the
 * HTML the server sends.
 *
 * The subject is in a sticky header with the way back beside it. On a phone that
 * back link is the only way out of a thread that is otherwise several screens of
 * somebody else's HTML, so it stays pinned rather than scrolling away.
 */

interface ThreadPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: ThreadPageProps) {
  const { id } = await params;
  return { title: "Thread", other: { "thread-id": id } };
}

export default async function ThreadPage({ params }: ThreadPageProps) {
  const { id } = await params;
  const viewer = await requireViewer(`/thread/${id}`);

  let thread;
  try {
    thread = await apiFetch(viewer, `/threads/${id}`, threadDetailSchema);
  } catch (error) {
    if (isApiUnavailable(error)) return <StartingUp />;
    // A thread belonging to someone else is a 404 from the API (the tenancy filter
    // makes it not exist), and it stays a 404 here — no "forbidden" that would
    // confirm the id is real.
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const participants = thread.participants
    .map((person) => person.name ?? person.email)
    .join(", ");

  return (
    <>
      <PageHeader
        title={thread.subject ?? "(no subject)"}
        description={participants}
        actions={
          <Link
            href="/inbox/all"
            className="inline-flex items-center gap-1.5 text-[0.8125rem] font-medium text-muted transition-colors hover:text-ink"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Inbox
          </Link>
        }
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 pb-3 text-xs text-muted">
          <span className="tabular-nums">
            {`${thread.messageCount} message${thread.messageCount === 1 ? "" : "s"}`}
          </span>
          {thread.category !== null && (
            <Badge tone="neutral" size="sm">
              {thread.category}
            </Badge>
          )}
          {thread.priority !== null && (
            <Badge
              tone={
                thread.priority === "URGENT"
                  ? "danger"
                  : thread.priority === "HIGH"
                    ? "warning"
                    : "neutral"
              }
              size="sm"
            >
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
      </PageHeader>

      <PageBody className="space-y-4">
        {/*
          The banner is a client component because of the appeal control, and it is
          handed the whole assessment rather than a level: the reasons are the product
          (§6), and a banner that only knew `threatLevel` could not show them. It goes
          first, above even the summary — a warning the reader meets after reading a
          model's account of the message is a warning that arrived late.
        */}
        {thread.threat !== null && <ThreatBanner threat={thread.threat} />}

        {thread.summary !== null && <SummaryCard summary={thread.summary} />}

        {/*
          Oldest first, which is how the API returns them: a conversation read in the
          order it happened. Each body is sandboxed independently.
        */}
        {thread.messages.map((message) => (
          <MessageCard
            key={message.id}
            message={message}
            defaultTranslationLang={thread.defaultTranslationLang}
          />
        ))}

        {/*
          The composer goes last, where a reply belongs in a conversation. The recipient
          is handed down from the API rather than derived here: the address on the send
          button must be the address the send path will actually use.
        */}
        <ReplyComposer
          threadId={thread.id}
          recipients={thread.replyRecipients}
          demo={viewer.kind === "demo"}
        />
      </PageBody>
    </>
  );
}
