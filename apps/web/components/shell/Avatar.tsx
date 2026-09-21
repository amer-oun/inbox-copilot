import { cn } from "../../lib/utils";

/**
 * Initials on a tinted disc. Deliberately not the provider's profile photo: that
 * is a third-party URL fetched on every page of an email client, which hands a
 * request — and a referrer — to Google on every navigation for no product gain.
 */
function initials(name: string | null | undefined, email: string | null | undefined) {
  const source = name?.trim() ?? "";
  if (source.length > 0) {
    const parts = source.split(/\s+/);
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
    return (first + last).toUpperCase();
  }
  return (email?.[0] ?? "?").toUpperCase();
}

export function Avatar({
  name,
  email,
  className,
}: {
  name?: string | null | undefined;
  email?: string | null | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-8 shrink-0 select-none items-center justify-center rounded-full",
        "bg-accent-soft text-[0.6875rem] font-semibold tracking-wide text-accent",
        className,
      )}
    >
      {initials(name, email)}
    </span>
  );
}
