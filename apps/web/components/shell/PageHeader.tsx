import { cn } from "../../lib/utils";
import { MOBILE_BAR_OFFSET } from "./layout";

/**
 * The top of every page inside the shell: one h1, one line of context, optional
 * actions on the right. Shared so the four pages agree on where the title sits —
 * a heading that moves by eight pixels between screens is the sort of thing that
 * reads as "unfinished" without anyone being able to say why.
 *
 * `sticky` by default: the inbox list and a long thread both scroll past their
 * own heading, and losing the subject you are reading is disorienting.
 *
 * Two widths. `prose` is for the pages that are mostly sentences — scheduled,
 * follow-ups, settings — and is capped near 70ch. `wide` is for the inbox, where
 * the row is a scanning surface and a narrow measure would strand the timestamp
 * half a screen from the sender. The header and its body share the width so the
 * title sits over the content rather than beside it.
 */

const WIDTHS = {
  prose: "max-w-3xl",
  wide: "max-w-5xl",
} as const;

export type PageWidth = keyof typeof WIDTHS;

export function PageHeader({
  title,
  description,
  actions,
  width = "prose",
  sticky = true,
  className,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  width?: PageWidth;
  sticky?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <header
      className={cn(
        "border-b border-line bg-canvas/85 backdrop-blur",
        // Under the phone app bar, flush with the top on a wide screen where
        // there is no app bar to sit under.
        sticky && "sticky top-(--app-bar) z-(--z-sticky) lg:top-0",
        className,
      )}
      style={{
        ["--app-bar" as string]: MOBILE_BAR_OFFSET,
      }}
    >
      <div className={cn("mx-auto w-full px-4 sm:px-6", WIDTHS[width])}>
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3.5">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold tracking-tight text-ink">
              {title}
            </h1>
            {description === undefined ? null : (
              <p className="mt-0.5 text-[0.8125rem] leading-snug text-muted">
                {description}
              </p>
            )}
          </div>
          {actions === undefined ? null : (
            <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
          )}
        </div>
        {children}
      </div>
    </header>
  );
}

/** The content column under a header, at the same width. */
export function PageBody({
  width = "prose",
  className,
  ...props
}: React.ComponentProps<"div"> & { width?: PageWidth }) {
  return (
    <div
      className={cn("mx-auto w-full px-4 pb-16 pt-5 sm:px-6", WIDTHS[width], className)}
      {...props}
    />
  );
}
