"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAgentContext } from "@copilotkit/react-core/v2";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

type Props = {
  fqid: string;
  relPath: string;
  initialRaw: string;
  authority: string;
  rollout: string;
  version: string;
  description?: string;
  openhandsUrl: string;
};

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "ok"; at: string }
  | { kind: "err"; msg: string };

type PrResult =
  | { ok: true; branch: string; hash: string; pushed: boolean; prUrl: string | null; pushCmd: string }
  | { ok: false; error: string };

export default function SkillEditor(props: Props) {
  const [raw, setRaw] = useState(props.initialRaw);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const dirty = raw !== props.initialRaw;
  const setupDone = useRef(false);
  const seedDone = useRef(false);
  const [iframeUrl, setIframeUrl] = useState<string>(props.openhandsUrl);
  const [seedStatus, setSeedStatus] = useState<"idle" | "seeding" | "ready" | "failed">("idle");

  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [prLoading, setPrLoading] = useState(false);
  const [prResult, setPrResult] = useState<PrResult | null>(null);

  // Expose current skill content + metadata to the CopilotKit chat overlay
  useAgentContext({
    description: "Currently open skill in the Skill Studio editor",
    value: {
      fqid: props.fqid,
      authority: props.authority,
      rollout_stage: props.rollout,
      version: props.version,
      file_path: props.relPath,
      skill_content: raw,
    },
  });

  // Ensure OpenHands is pre-configured with LiteLLM on first load (non-blocking)
  useEffect(() => {
    if (setupDone.current) return;
    setupDone.current = true;
    fetch("/api/openhands-setup").catch(() => null);
  }, []);

  // Pre-seed an OpenHands conversation so the right pane lands on a session
  // that already knows which SKILL.md to open. Resumes if a conversation_id
  // was previously stashed for this skill.
  useEffect(() => {
    if (seedDone.current) return;
    seedDone.current = true;
    const cacheKey = `oh-conv:${props.fqid}`;
    const cached = typeof window !== "undefined" ? window.localStorage.getItem(cacheKey) : null;
    if (cached) {
      setIframeUrl(`${props.openhandsUrl}/conversations/${cached}`);
      setSeedStatus("ready");
      return;
    }
    setSeedStatus("seeding");
    fetch("/api/openhands-seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fqid: props.fqid,
        relPath: props.relPath,
        description: props.description,
      }),
    })
      .then((r) => r.json())
      .then((body: { ok: boolean; conversation_id?: string; url?: string }) => {
        if (body.ok && body.conversation_id && body.url) {
          window.localStorage.setItem(cacheKey, body.conversation_id);
          setIframeUrl(body.url);
          setSeedStatus("ready");
        } else {
          setSeedStatus("failed");
        }
      })
      .catch(() => setSeedStatus("failed"));
  }, [props.fqid, props.relPath, props.description, props.openhandsUrl]);

  async function onSave() {
    setSave({ kind: "saving" });
    try {
      const res = await fetch(`/api/skills/${props.fqid}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
      });
      const body = await res.json();
      if (!res.ok || body.ok === false) {
        setSave({ kind: "err", msg: body.error ?? `HTTP ${res.status}` });
        return;
      }
      setSave({ kind: "ok", at: new Date().toLocaleTimeString() });
      // Refresh diff after save so the panel reflects the latest on-disk state
      if (diffOpen) void loadDiff();
    } catch (e) {
      setSave({ kind: "err", msg: (e as Error).message });
    }
  }

  async function loadDiff() {
    setDiffLoading(true);
    try {
      const res = await fetch(`/api/skills/${props.fqid}/diff`);
      const body = await res.json();
      setDiff(body.diff ?? "");
    } catch {
      setDiff(null);
    } finally {
      setDiffLoading(false);
    }
  }

  function onToggleDiff() {
    if (diffOpen) {
      setDiffOpen(false);
    } else {
      setDiffOpen(true);
      setPrResult(null);
      void loadDiff();
    }
  }

  async function onOpenPr() {
    setPrLoading(true);
    setPrResult(null);
    try {
      const res = await fetch(`/api/skills/${props.fqid}/pr`, { method: "POST" });
      const body: PrResult = await res.json();
      setPrResult(body);
      if (body.ok && body.prUrl) {
        window.open(body.prUrl, "_blank", "noopener,noreferrer");
      }
    } catch (e) {
      setPrResult({ ok: false, error: (e as Error).message });
    } finally {
      setPrLoading(false);
    }
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-zinc-900/60 px-6 py-3">
        <div className="flex items-center justify-between">
          <div>
            <Link href="/skills" className="text-xs text-blue-400 hover:underline">&larr; catalogue</Link>
            <div className="mt-1 flex items-center gap-3">
              <h1 className="font-mono text-lg">{props.fqid}</h1>
              <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{props.authority}</span>
              <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{props.rollout}</span>
              <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">v{props.version}</span>
            </div>
            <div className="mt-1 font-mono text-xs text-zinc-500">{props.relPath}</div>
          </div>
          <div className="flex items-center gap-3">
            {save.kind === "ok" && <span className="text-xs text-emerald-400">saved {save.at}</span>}
            {save.kind === "err" && <span className="text-xs text-red-400">error: {save.msg}</span>}
            {save.kind === "saving" && <span className="text-xs text-zinc-400">saving&hellip;</span>}
            <button
              onClick={onToggleDiff}
              className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700"
            >
              {diffOpen ? "Close diff" : "Diff ↓"}
            </button>
            <button
              onClick={onOpenPr}
              disabled={prLoading}
              className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {prLoading ? "Creating…" : "Open PR ↗"}
            </button>
            <button
              onClick={onSave}
              disabled={!dirty || save.kind === "saving"}
              className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              Save{dirty ? " *" : ""}
            </button>
          </div>
        </div>
      </div>

      {/* Diff panel */}
      {diffOpen && (
        <div className="border-b border-zinc-800 bg-black/50 max-h-72 overflow-auto">
          {diffLoading ? (
            <div className="px-5 py-3 text-xs text-zinc-500">Loading diff…</div>
          ) : diff === null ? (
            <div className="px-5 py-3 text-xs text-red-400">Failed to load diff.</div>
          ) : diff.trim() === "" ? (
            <div className="px-5 py-3 text-xs text-zinc-500">No changes vs HEAD. Save your edits first, then view the diff.</div>
          ) : (
            <pre className="px-5 py-3 font-mono text-xs leading-5 select-text">
              {diff.split("\n").map((line, i) => (
                <span
                  key={i}
                  className={
                    line.startsWith("+") && !line.startsWith("+++")
                      ? "text-emerald-400 block"
                      : line.startsWith("-") && !line.startsWith("---")
                      ? "text-red-400 block"
                      : line.startsWith("@@")
                      ? "text-blue-400 block"
                      : "text-zinc-500 block"
                  }
                >
                  {line || " "}
                </span>
              ))}
            </pre>
          )}
          {prResult && (
            <div className={`mx-5 mb-3 rounded px-3 py-2 text-xs font-mono ${prResult.ok ? "bg-emerald-950/60 text-emerald-300" : "bg-red-950/60 text-red-300"}`}>
              {prResult.ok
                ? prResult.pushed
                  ? <>Branch <b>{prResult.branch}</b> pushed. {prResult.prUrl ? <a href={prResult.prUrl} target="_blank" rel="noreferrer" className="underline">Open PR on GitHub ↗</a> : "No remote configured."}</>
                  : <>Branch <b>{prResult.branch}</b> created locally. Run: <code>{prResult.pushCmd}</code></>
                : `Error: ${prResult.error}`}
            </div>
          )}
        </div>
      )}

      {/* Two-pane: Monaco | OpenHands */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex w-1/2 flex-col border-r border-zinc-800">
          <div className="border-b border-zinc-800 bg-zinc-900/40 px-4 py-2 text-xs uppercase text-zinc-500">SKILL.md</div>
          <div className="flex-1">
            <MonacoEditor
              height="100%"
              defaultLanguage="markdown"
              theme="vs-dark"
              value={raw}
              onChange={(v) => setRaw(v ?? "")}
              options={{
                fontSize: 13,
                minimap: { enabled: false },
                wordWrap: "on",
                scrollBeyondLastLine: false,
              }}
            />
          </div>
        </div>
        <div className="flex w-1/2 flex-col">
          <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/40 px-4 py-2 text-xs uppercase text-zinc-500">
            <span>
              OpenHands sandbox
              {seedStatus === "seeding" && <span className="ml-2 normal-case text-zinc-400">seeding…</span>}
              {seedStatus === "ready" && <span className="ml-2 normal-case text-emerald-400">seeded</span>}
              {seedStatus === "failed" && <span className="ml-2 normal-case text-red-400">seed failed — cold start</span>}
            </span>
            <a href={iframeUrl} target="_blank" rel="noreferrer" className="text-blue-400 normal-case hover:underline">open in new tab &rarr;</a>
          </div>
          <iframe
            src={iframeUrl}
            title="OpenHands"
            className="flex-1 w-full bg-zinc-950"
          />
        </div>
      </div>
    </div>
  );
}