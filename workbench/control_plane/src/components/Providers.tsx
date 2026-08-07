"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import ViewModeProvider from "@/components/ViewModeProvider";
import AccessProvider from "@/components/AccessProvider";
import AppearanceProvider from "@/components/ThemeProvider";

export default function Providers({
  children,
}: {
  children: React.ReactNode;
  session?: never;
}) {
  return (
    <SessionProvider refetchOnWindowFocus={false}>
      {/* next-themes owns the light/dark axis (the `.light` / `.dark` class).
          AppearanceProvider owns the orthogonal style axis — which theme, at
          what density, with which accent — via the `data-theme` attribute. */}
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange>
        <AppearanceProvider />
        <ViewModeProvider>
          {/* Inside SessionProvider: access is resolved for the signed-in
              member, so it must not mount before the session exists. */}
          <AccessProvider>{children}</AccessProvider>
        </ViewModeProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}