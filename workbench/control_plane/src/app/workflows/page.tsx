"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAgentContext } from "@copilotkit/react-core/v2";

// n8n is proxied through Next.js at /n8n/ (same-origin) to avoid
// cross-port ERR_CONNECTION_REFUSED in the browser iframe.
// The direct URL is kept for the "Open n8n" button only.
const N8N_PROXY_PATH = "/n8n";
const N8N_DIRECT_URL =
  (process.env.NEXT_PUBLIC_N8N_URL ?? "http://127.0.0.1:5678").replace(
    "localhost",
    "127.0.0.1",
  );

export default function Workflows() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const authAttempted = useRef(false);

  // Expose Workflow Editor context to the CopilotKit chat overlay
  useAgentContext({
    description: "Currently active pane in the Jannet.AI Control Plane: Workflow Editor (n8n)",
    value: {
      pane: "workflow-editor",
      tool: "n8n",
      description: "Visual editor for cron, webhook, and event-driven automations. Workflows are version-controlled in the workflows/ directory via scripts/n8n_export.py.",
      connection_status: status,
    },
  });

  useEffect(() => {
    if (authAttempted.current) return;
    authAttempted.current = true;

    // Run auth + credential setup in parallel. Setup is fire-and-forget
    // (n8n might not be running, and that's fine — it's idempotent on retry).
    Promise.all([
      fetch("/api/n8n-auth"),
      fetch("/api/n8n-setup").catch(() => null), // non-blocking
    ])
      .then(([authRes]) => {
        if (!authRes.ok) setStatus("error");
        else setStatus("ready");
      })
      .catch(() => {
        // n8n might still work if the user already has a valid cookie
        setStatus("ready");
      });
  }, []);

  return (
    <div className="flex h-screen flex-col">
      <div className="border-b border-zinc-800 bg-zinc-900/60 px-6 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Workflow Editor</h1>
            <p className="mt-1 text-sm text-zinc-400">
              Visual editor for cron, webhook and event-driven workflows. Workflows are
              version-controlled in <code className="font-mono text-xs">workflows/</code>
              via <code className="font-mono text-xs">scripts/n8n_export.py</code>.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <a
              href={N8N_DIRECT_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm hover:bg-zinc-700"
            >
              Open n8n &rarr;
            </a>
            <Link href="/skills" className="text-sm text-blue-400 hover:underline">
              skills &rarr;
            </Link>
          </div>
        </div>
      </div>

      {status === "ready" && (
        <iframe
          key={N8N_PROXY_PATH}
          src={N8N_PROXY_PATH}
          title="n8n"
          className="flex-1 w-full bg-zinc-950"
          // No sandbox — n8n is a trusted local tool and needs unrestricted JS/WS
        />
      )}

      {status === "loading" && (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
          Connecting to n8n…
        </div>
      )}

      {status === "error" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-sm">
          <p className="text-zinc-400">
            Could not reach n8n at{" "}
            <code className="rounded bg-zinc-800 px-1 font-mono text-xs">{N8N_PROXY_PATH}</code>.
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => {
                authAttempted.current = false;
                setStatus("loading");
              }}
              className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 hover:bg-zinc-700"
            >
              Retry
            </button>
            <a
              href={N8N_DIRECT_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-blue-700 bg-blue-900/40 px-3 py-2 text-blue-300 hover:bg-blue-900/60"
            >
              Open n8n directly
            </a>
          </div>
        </div>
      )}
    </div>
  );
}