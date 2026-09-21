import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { THEME_SCRIPT } from "../lib/theme";

export const metadata: Metadata = {
  title: {
    default: "Inbox Copilot",
    template: "%s · Inbox Copilot",
  },
  description: "AI email assistant for Gmail and Outlook",
};

export const viewport: Viewport = {
  // The shell pads itself with the safe-area insets, which only exist under this.
  viewportFit: "cover",
  // Declared for both so the browser paints its own chrome to match immediately
  // rather than a frame later.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8fa" },
    { media: "(prefers-color-scheme: dark)", color: "#1b1d22" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    /*
     * `suppressHydrationWarning` because the script below writes `data-theme` onto
     * this element before React hydrates, so the server's markup and the browser's
     * DOM legitimately differ by one attribute. It suppresses the warning for this
     * element's own attributes only, not for its subtree.
     */
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Inline and synchronous, ahead of the stylesheet's first paint. Anything
          async paints the light theme first, and a white flash on the way into a
          dark inbox is what a theme setting exists to prevent.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh bg-canvas font-sans text-ink antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
