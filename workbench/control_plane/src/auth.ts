import NextAuth from "next-auth";
import MicrosoftEntraId from "next-auth/providers/microsoft-entra-id";

const ALLOWED_DOMAIN = process.env.AUTH_ALLOWED_DOMAIN ?? "fracktal.in";

/**
 * Dev-friendly: if no Microsoft credentials are configured we expose an empty
 * `providers` array and the middleware will allow all traffic. As soon as
 * AUTH_MICROSOFT_CLIENT_ID / AUTH_MICROSOFT_CLIENT_SECRET / AUTH_MICROSOFT_TENANT_ID
 * / AUTH_SECRET are set, auth flips on.
 */
const hasMicrosoft = Boolean(
  process.env.AUTH_MICROSOFT_CLIENT_ID &&
  process.env.AUTH_MICROSOFT_CLIENT_SECRET &&
  process.env.AUTH_MICROSOFT_TENANT_ID
);

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  secret: process.env.AUTH_SECRET ?? "dev-local-insecure-change-me",
  providers: hasMicrosoft
    ? [
        MicrosoftEntraId({
          clientId: process.env.AUTH_MICROSOFT_CLIENT_ID!,
          clientSecret: process.env.AUTH_MICROSOFT_CLIENT_SECRET!,
          tenantId: process.env.AUTH_MICROSOFT_TENANT_ID!,
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

export const isAuthEnabled = hasMicrosoft;