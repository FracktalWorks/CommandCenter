"use client";

/**
 * AccessProvider — the signed-in member's effective access, fetched once and
 * shared by the whole shell.
 *
 * Spec: ai-company-brain/specs/org_access_control.md §5 (seams 4 and 5).
 *
 * Two consumers: the Sidebar filters nav panes with it, and AccessGate blocks
 * direct navigation to a route the member cannot reach. Neither is a security
 * boundary — the gateway re-authorizes every request — but a sidebar full of
 * links that 403 is a worse product than one that shows what you actually have.
 *
 * `loading` matters: rendering the nav before access resolves would flash the
 * full sidebar and then remove items, which reads as a bug. Consumers hold
 * their layout until it clears.
 */

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { NO_ACCESS, fetchAccess, type Access } from "@/lib/access";

type AccessCtx = {
  access: Access;
  loading: boolean;
  /** Re-fetch after an admin change so the sidebar updates without a reload. */
  refresh: () => Promise<void>;
};

const Ctx = createContext<AccessCtx>({
  access: NO_ACCESS,
  loading: true,
  refresh: async () => {},
});

export function useAccess(): AccessCtx {
  return useContext(Ctx);
}

export default function AccessProvider({ children }: { children: ReactNode }) {
  const [access, setAccess] = useState<Access>(NO_ACCESS);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const next = await fetchAccess();
    setAccess(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    (async () => {
      const next = await fetchAccess(controller.signal);
      if (alive) {
        setAccess(next);
        setLoading(false);
      }
    })();

    // Re-resolve periodically so a revoked permission disappears from a
    // long-lived tab. The gateway caches for 60s, so polling faster than that
    // buys nothing.
    const interval = setInterval(() => {
      void refresh();
    }, 120_000);

    return () => {
      alive = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [refresh]);

  return (
    <Ctx.Provider value={{ access, loading, refresh }}>{children}</Ctx.Provider>
  );
}
