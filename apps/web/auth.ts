import NextAuth, { type DefaultSession } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { prisma } from "@inbox-copilot/db";
import { env } from "./lib/env";

/**
 * Sign-in only.
 *
 * These providers request `openid profile email` and nothing else: a user can
 * sign in without ever granting mailbox access, and granting mailbox access is a
 * separate, explicit flow (`/settings/accounts` → the core API). Keeping the two
 * apart is what makes "connect Gmail" a decision rather than a side effect of
 * logging in — and it keeps mail tokens out of the Auth.js `Account` table.
 *
 * Session strategy is `database`: sessions live in Postgres, so sign-out and
 * revocation take effect immediately instead of waiting for a JWT to expire.
 */

const LOGIN_SCOPES = "openid profile email";

declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: {
    strategy: "database",
    maxAge: 30 * 24 * 60 * 60, // 30 days
    updateAge: 24 * 60 * 60,
  },
  pages: {
    signIn: "/signin",
    error: "/signin",
  },
  providers: [
    Google({
      clientId: env.AUTH_GOOGLE_ID,
      clientSecret: env.AUTH_GOOGLE_SECRET,
      // No `access_type=offline` and no `prompt=consent`: we deliberately do not
      // want a long-lived Google token from the sign-in flow.
      authorization: { params: { scope: LOGIN_SCOPES } },
    }),
    MicrosoftEntraID({
      clientId: env.AUTH_MICROSOFT_ENTRA_ID_ID,
      clientSecret: env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      issuer: `https://login.microsoftonline.com/${env.AUTH_MICROSOFT_ENTRA_ID_TENANT}/v2.0`,
      authorization: { params: { scope: LOGIN_SCOPES } },
    }),
  ],
  callbacks: {
    /**
     * Expose the user id to server components. Every API call the BFF makes is
     * signed with this id as its subject, and every DB query is scoped by it.
     */
    session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
  trustHost: true,
});
