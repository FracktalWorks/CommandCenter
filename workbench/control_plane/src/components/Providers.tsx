"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import ViewModeProvider from "@/components/ViewModeProvider";
import AccessProvider from "@/components/AccessProvider";

export default function Providers({
  children,
}: {
  children: React.ReactNode;
  session?: never;
}) {
  return (
    <SessionProvider refetchOnWindowFocus={false}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange>
        <ViewModeProvider>
          {/* Inside SessionProvider: access is resolved for the signed-in
              member, so it must not mount before the session exists. */}
          <AccessProvider>{children}</AccessProvider>
        </ViewModeProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}