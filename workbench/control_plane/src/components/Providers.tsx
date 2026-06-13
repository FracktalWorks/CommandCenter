"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import ViewModeProvider from "@/components/ViewModeProvider";

export default function Providers({
  children,
}: {
  children: React.ReactNode;
  session?: never;
}) {
  return (
    <SessionProvider refetchOnWindowFocus={false}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange>
        <ViewModeProvider>{children}</ViewModeProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}