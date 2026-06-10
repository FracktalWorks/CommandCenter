import NextAuth from "next-auth";
import MicrosoftEntraId from "next-auth/providers/microsoft-entra-id";

/**
 * Microsoft Entra ID (Azure AD) SSO for @fracktal.in.
 *
 * The tenant-level app registration ensures only users in the Fracktal
 * Microsoft 365 directory can sign in — no domain check needed.
 *
 * Dev-friendly: if no AUTH_MICROSOFT_ENTRA_ID_ID is set, middleware allows
 * all traffic. Set the env vars to enable auth.
 */
const hasProvider = Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_ID);

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  secret: process.env.AUTH_SECRET ?? "dev-local-insecure-change-me",
  providers: [
    MicrosoftEntraId({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID ?? "",
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET ?? "",
      issuer: `https://login.microsoftonline.com/${process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT ?? "organizations"}/v2.0`,
    }),
  ],
  callbacks: {
    async jwt({ token, profile, account }) {
      if (profile?.email) {
        token.email = profile.email as string;
      }
      if (account?.provider) {
        token.provider = account.provider;
      }
      return token;
    },
    async session({ session, token }) {
      if (token?.email) {
        session.user.email = token.email as string;
      }
      if (token?.name) {
        session.user.name = token.name as string;
      }
      return session;
    },
  },
  pages: {
    signIn: "/signin",
  },
});

export const isAuthEnabled = hasProvider;