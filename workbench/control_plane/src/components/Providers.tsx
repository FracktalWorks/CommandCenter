"use client";

import { SessionProvider } from "next-auth/react";
import ViewModeProvider from "@/components/ViewModeProvider";

export default function Providers({
  children,
}: {
  children: React.ReactNode;
  session?: never;
}) {
  return (
    <SessionProvider refetchOnWindowFocus={false}>
      <ViewModeProvider>{children}</ViewModeProvider>
    </SessionProvider>
  );
}