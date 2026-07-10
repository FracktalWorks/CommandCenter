"use client";

import { useEffect, useState } from "react";
import { getAssistantSettings } from "../lib/api";
import { cleanSignatureHtml } from "./SignatureEditor";

// Signatures rarely change within a session; cache per account so every draft
// card doesn't re-fetch the settings row.
const _sigCache = new Map<string, string>();

/**
 * Renders the account's HTML signature exactly as it will be appended on send
 * (Outlook/Gmail style — visible in the draft, sanitised). Renders nothing when
 * no signature is configured or while it's still loading.
 */
export function SignaturePreview({ accountId }: { accountId?: string | null }) {
  const [sig, setSig] = useState<string>(
    () => (accountId && _sigCache.get(accountId)) || "",
  );

  useEffect(() => {
    if (!accountId) return;
    const cached = _sigCache.get(accountId);
    if (cached !== undefined) {
      setSig(cached);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const s = await getAssistantSettings(accountId);
        const html = (s?.signature || "").trim();
        _sigCache.set(accountId, html);
        if (!cancelled) setSig(html);
      } catch {
        /* no signature preview on failure — the send still appends it */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  if (!sig) return null;
  return (
    <div className="mt-1 rounded-md border border-dashed border-border bg-secondary/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
        Signature
      </div>
      <div
        className="text-xs text-foreground leading-relaxed [&_a]:text-primary [&_a]:underline [&_img]:max-w-full"
        dangerouslySetInnerHTML={{ __html: cleanSignatureHtml(sig) }}
      />
    </div>
  );
}
