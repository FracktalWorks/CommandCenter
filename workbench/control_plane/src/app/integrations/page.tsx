"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Redirect /integrations → /apis (permanent rename). */
export default function IntegrationsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/apis");
  }, [router]);
  return null;
}
