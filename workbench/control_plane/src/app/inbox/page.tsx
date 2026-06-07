"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** /inbox has been merged into /agents — each GitHub Copilot agent card
 *  now shows its pending self-mutation commits inline. */
export default function InboxRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/agents"); }, [router]);
  return (
    <div className="flex items-center justify-center h-full text-sm text-zinc-600">
      Redirecting to Agents...
    </div>
  );
}
