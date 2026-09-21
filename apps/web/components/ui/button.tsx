import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

/**
 * The one button in this application.
 *
 * Not a client component: it has no state, so it renders on the server and works
 * inside a plain `<form>` submission.
 *
 * Every variant carries the full state set — default, hover, active, focus,
 * disabled — because a control that only has two of them is the thing that makes
 * an interface feel unfinished. `active:` translates by half a pixel rather than
 * scaling: a scale on a text label reflows the glyphs and shimmers.
 */
const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap",
    "rounded-[var(--radius-control)] font-medium",
    "transition-[background-color,border-color,color,box-shadow,translate] duration-150",
    "ease-[var(--ease-out-quart)] active:translate-y-px",
    "disabled:pointer-events-none disabled:opacity-45",
    "[&_svg]:size-4 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        /* The page's single most important action. One per screen, usually. */
        primary: "bg-accent text-accent-ink shadow-raise hover:brightness-[1.08]",
        /* The workhorse: everything that is an action but not *the* action. */
        outline:
          "border border-line-strong bg-surface text-ink shadow-raise hover:bg-raised hover:border-line-strong",
        /* Tertiary — dismissals, toggles, anything that should not compete. */
        ghost: "text-muted hover:bg-raised hover:text-ink",
        /* Destructive and irreversible. Outlined, never filled: a solid red
           button is the easiest thing on a page to click by accident. */
        danger:
          "border border-danger-line bg-surface text-danger hover:bg-danger-soft hover:border-danger",
      },
      size: {
        sm: "h-8 gap-1.5 px-2.5 text-xs [&_svg]:size-3.5",
        md: "h-9 px-3.5 text-sm",
        lg: "h-11 px-5 text-[0.9375rem]",
        icon: "size-9 px-0",
        "icon-sm": "size-8 px-0 [&_svg]:size-3.5",
      },
      block: { true: "w-full", false: "" },
    },
    defaultVariants: { variant: "primary", size: "md", block: false },
  },
);

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, block, ...props }: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size, block }), className)}
      {...props}
    />
  );
}

export { buttonVariants };
