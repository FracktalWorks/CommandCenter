"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useCopilotReadable } from "@copilotkit/react-core";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

type Props = {
  fqid: string;
  relPath: string;
  initialRaw: string;
  authority: string;
  rollout: string;
  version: string;
  openhandsUrl: string;
};

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "ok"; at: string }
  | { kind: "err"; msg: string };

export default function SkillEditor(props: Props) {
  const [raw, setRaw] = useState(props.initialRaw);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const dirty = raw !== props.initialRaw;
  const setupDone = useRef(false);

  // Expose current skill content + metadata to the CopilotKit chat overlay
  useCopilotReadable({
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
    } catch (e) {
      setSave({ kind: "err", msg: (e as Error).message });
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
              onClick={onSave}
              disabled={!dirty || save.kind === "saving"}
              className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              Save{dirty ? " *" : ""}
            </button>
          </div>
        </div>
      </div>

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
            <span>OpenHands sandbox</span>
            <a href={props.openhandsUrl} target="_blank" rel="noreferrer" className="text-blue-400 normal-case hover:underline">open in new tab &rarr;</a>
          </div>
          <iframe
            src={props.openhandsUrl}
            title="OpenHands"
            className="flex-1 w-full bg-zinc-950"
          />
        </div>
      </div>
    </div>
  );
}