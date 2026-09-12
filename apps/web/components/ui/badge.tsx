import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
  {
    variants: {
      tone: {
        neutral: "border-border-subtle bg-canvas text-muted",
        info: "border-accent/30 bg-accent/10 text-accent",
        success: "border-success/30 bg-success/10 text-success",
        warning: "border-warning/35 bg-warning/10 text-warning",
        danger: "border-danger/35 bg-danger/10 text-danger",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
