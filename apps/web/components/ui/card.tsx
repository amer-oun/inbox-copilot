import type * as React from "react";
import { cn } from "../../lib/utils";

/**
 * A bordered panel. Used where content genuinely is a separate object — a mailbox,
 * a scheduled send, a settings group — and not as a wrapper around everything: a
 * page of cards inside cards is how a product UI loses its hierarchy.
 *
 * The border does the work; the shadow is a single 1px lift in the light theme and
 * nothing at all in the dark one, where a drop shadow reads as grime.
 */
export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-card)] border border-line bg-surface shadow-raise",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("space-y-1 p-5 pb-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      className={cn("text-sm font-semibold tracking-tight text-ink", className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-sm leading-relaxed text-muted", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("p-5 pt-0", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-t border-line bg-panel/60 px-5 py-3",
        "rounded-b-[var(--radius-card)]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The section heading used down the settings page and above each list. A plain
 * `h2` plus optional description — not a card header, because these introduce a
 * region rather than wrap one.
 */
export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
        {description === undefined ? null : (
          <p className="max-w-[68ch] text-sm leading-relaxed text-muted">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
