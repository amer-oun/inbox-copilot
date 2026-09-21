import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

/**
 * A label, not a button. Badges here say what something *is* — a category, a
 * status, a verdict — and nothing in the app makes one clickable.
 *
 * Two shapes rather than one: `soft` is the default chip, and `solid` exists for
 * the few places a verdict has to win against a busy row (a PHISHING marker in
 * the thread list). Both are readable at 4.5:1 in both themes; the tinted
 * backgrounds and their text colours were checked as pairs.
 */
const badgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1 rounded-full text-xs font-medium [&_svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "border-line bg-panel text-muted",
        info: "border-accent-line bg-accent-soft text-accent",
        success: "border-success-line bg-success-soft text-success",
        warning: "border-warning-line bg-warning-soft text-warning",
        danger: "border-danger-line bg-danger-soft text-danger",
      },
      variant: {
        soft: "border px-2 py-0.5",
        solid: "px-2 py-0.5 font-semibold",
      },
      size: {
        sm: "px-1.5 text-[0.6875rem] leading-4",
        md: "",
      },
    },
    compoundVariants: [
      { variant: "solid", tone: "danger", className: "bg-danger text-surface" },
      { variant: "solid", tone: "warning", className: "bg-warning text-surface" },
      { variant: "solid", tone: "info", className: "bg-accent text-accent-ink" },
      { variant: "solid", tone: "success", className: "bg-success text-surface" },
      { variant: "solid", tone: "neutral", className: "bg-raised text-ink" },
    ],
    defaultVariants: { tone: "neutral", variant: "soft", size: "md" },
  },
);

export type BadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, variant, size, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, variant, size }), className)} {...props} />
  );
}
