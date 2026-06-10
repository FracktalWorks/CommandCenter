"use client";

import { SessionProvider } from "next-auth/react";

export default function Providers({
  children,
  session,
}: {
  children: React.ReactNode;
  session?: never;
}) {
  return (
    <SessionProvider refetchOnWindowFocus={false}>
      {children}
    </SessionProvider>
  );
}