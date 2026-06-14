"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Redirect /apis → /integrations (renamed page). */
export default function ApisRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/integrations");
  }, [router]);
  return null;
}
