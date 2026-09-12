import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Inbox Copilot",
  description: "AI email assistant for Gmail and Outlook",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
