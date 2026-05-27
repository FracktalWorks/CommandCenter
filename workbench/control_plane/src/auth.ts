import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const ALLOWED_DOMAIN = process.env.AUTH_ALLOWED_DOMAIN ?? "fracktal.in";

/**
 * Dev-friendly: if no Google credentials are configured we expose an empty
 * `providers` array and the middleware will allow all traffic. As soon as
 * AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET / AUTH_SECRET are set, auth flips on.
 */
const hasGoogle = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  secret: process.env.AUTH_SECRET ?? "dev-local-insecure-change-me",
  providers: hasGoogle
    ? [
        Google({
          clientId: process.env.AUTH_GOOGLE_ID!,
          clientSecret: process.env.AUTH_GOOGLE_SECRET!,
        }),
      ]
    : [],
  callbacks: {
    async signIn({ profile }) {
      const email = profile?.email ?? "";
      const ok = email.toLowerCase().endsWith("@" + ALLOWED_DOMAIN.toLowerCase());
      return ok;
    },
    async session({ session, token }) {
      // Surface the email/name so the UI can show "Signed in as ...".
      if (token?.email) session.user.email = token.email as string;
      return session;
    },
  },
  pages: {
    signIn: "/signin",
  },
});

export const isAuthEnabled = hasGoogle;