"use client";

/**
 * Module Studio — the org module library + conversational generator
 * (spec: workflows_app.md §5). Describe a task in plain language → the
 * gateway generates a validated pure-transform Python module → test it on
 * sample input → refine conversationally → save to the library. `ready`
 * modules become "Module" nodes in every workflow's palette.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { useTheme } from "next-themes";
import {
  Boxes,
  Check,
  Loader2,
  Play,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  createModule,
  deleteModule,
  generateModule,
  getModule,
  listModules,
  testModuleCode,
  updateModule,
} from "../lib/api";
import type { GeneratedModule, ModuleSummary } from "../lib/types";

type ChatTurn = { role: "user" | "assistant"; content: string };

const STATUS_BADGE: Record<string, string> = {
  ready: "bg-success/10 text-success border-success/20",
  draft: "bg-warning/10 text-warning border-warning/20",
  disabled: "bg-muted text-muted-foreground border-border",
};

export default function ModuleStudio() {
  const { resolvedTheme } = useTheme();
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The working draft (either a generated module or a loaded one).
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [code, setCode] = useState("");
  const [schemas, setSchemas] = useState<{
    input: Record<string, unknown>;
    output: Record<string, unknown>;
  }>({ input: {}, output: {} });
  const [provenance, setProvenance] = useState<Record<string, unknown>>({});
  const [status, setStatus] = useState<string>("draft");

  const [prompt, setPrompt] = useState("");
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [generating, setGenerating] = useState(false);
  const [testInput, setTestInput] = useState("{\n  \n}");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setModules(await listModules());
    } catch {
      setModules([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  const selectModule = useCallback(async (id: string) => {
    try {
      const detail = await getModule(id);
      setSelectedId(id);
      setName(detail.name);
      setDescription(detail.description);
      setCode(detail.code);
      setSchemas({ input: detail.input_schema, output: detail.output_schema });
      setProvenance(detail.provenance);
      setStatus(detail.status);
      setChat([]);
      setTestResult(null);
      setNotice(null);
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e));
    }
  }, []);

  const startFresh = useCallback(() => {
    setSelectedId(null);
    setName("");
    setDescription("");
    setCode("");
    setSchemas({ input: {}, output: {} });
    setProvenance({});
    setStatus("draft");
    setChat([]);
    setTestResult(null);
    setNotice(null);
  }, []);

  const onGenerate = useCallback(async () => {
    const ask = prompt.trim();
    if (!ask || generating) return;
    setGenerating(true);
    setNotice(null);
    setChat((c) => [...c, { role: "user", content: ask }]);
    setPrompt("");
    try {
      const res = await generateModule({
        prompt: ask,
        current_code: code || undefined,
        history: chat.slice(-10),
      });
      const mod: GeneratedModule = res.module;
      setCode(mod.code);
      if (!selectedId) setName(mod.name);
      if (mod.description) setDescription(mod.description);
      setSchemas({ input: mod.input_schema, output: mod.output_schema });
      setProvenance(mod.provenance);
      setChat((c) => [
        ...c,
        {
          role: "assistant",
          content: res.ok
            ? `Generated \`${mod.name}\` — ${mod.description || "ready to test."}`
            : `Generated with validation issues: ${JSON.stringify(res.violations)}`,
        },
      ]);
    } catch (e) {
      setChat((c) => [
        ...c,
        { role: "assistant", content: `Generation failed: ${String(e instanceof Error ? e.message : e)}` },
      ]);
    } finally {
      setGenerating(false);
    }
  }, [prompt, generating, code, chat, selectedId]);

  const onTest = useCallback(async () => {
    if (!code || testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      let inputs: Record<string, unknown> = {};
      try {
        inputs = JSON.parse(testInput || "{}");
      } catch {
        setTestResult("Test input is not valid JSON");
        setTesting(false);
        return;
      }
      const res = await testModuleCode(code, inputs);
      setTestResult(
        res.ok
          ? JSON.stringify(res.output, null, 2)
          : `✗ ${res.error ?? JSON.stringify(res.violations)}`
      );
    } catch (e) {
      setTestResult(`✗ ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setTesting(false);
    }
  }, [code, testInput, testing]);

  const onSave = useCallback(async () => {
    if (!code || !name.trim() || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      if (selectedId) {
        await updateModule(selectedId, {
          name: name.trim(),
          description,
          code,
          input_schema: schemas.input,
          output_schema: schemas.output,
        });
        setNotice("Saved.");
      } else {
        const created = await createModule({
          name: name.trim(),
          description,
          code,
          input_schema: schemas.input,
          output_schema: schemas.output,
          provenance,
          status: "draft",
        });
        setSelectedId(created.id);
        setNotice("Saved to the library as a draft.");
      }
      await load();
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  }, [code, name, description, schemas, provenance, selectedId, saving, load]);

  const onToggleReady = useCallback(async () => {
    if (!selectedId) return;
    const next = status === "ready" ? "draft" : "ready";
    try {
      await updateModule(selectedId, { status: next });
      setStatus(next);
      await load();
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e));
    }
  }, [selectedId, status, load]);

  const onDelete = useCallback(async () => {
    if (!selectedId) return;
    try {
      await deleteModule(selectedId);
      startFresh();
      await load();
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e));
    }
  }, [selectedId, startFresh, load]);

  return (
    <div className="flex-1 min-h-0 flex">
      {/* Library list */}
      <div className="w-56 sm:w-64 border-r border-border shrink-0 flex flex-col">
        <div className="p-3 border-b border-border">
          <button
            onClick={startFresh}
            className="w-full rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 tech-transition flex items-center justify-center gap-1.5"
          >
            <Sparkles className="w-3.5 h-3.5" />
            New module
          </button>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1">
          {loading && (
            <div className="flex justify-center py-6">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loading && modules.length === 0 && (
            <p className="text-xs text-muted-foreground p-2">
              No modules yet — describe one to get started.
            </p>
          )}
          {modules.map((m) => (
            <button
              key={m.id}
              onClick={() => selectModule(m.id)}
              className={`w-full text-left rounded-lg px-2.5 py-2 tech-transition border ${
                selectedId === m.id
                  ? "border-primary/40 bg-primary/5"
                  : "border-transparent hover:bg-secondary"
              }`}
            >
              <div className="flex items-center gap-1.5">
                <Boxes className="w-3.5 h-3.5 text-sky-500 shrink-0" />
                <span className="text-xs font-medium text-foreground truncate">
                  {m.name}
                </span>
                <span
                  className={`ml-auto text-[9px] px-1.5 py-px rounded-full border ${STATUS_BADGE[m.status]}`}
                >
                  {m.status}
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">
                {m.description || "—"}
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* Workbench */}
      <div className="flex-1 min-w-0 flex flex-col lg:flex-row">
        {/* Chat / generator */}
        <div className="lg:w-80 xl:w-96 shrink-0 border-b lg:border-b-0 lg:border-r border-border flex flex-col max-h-64 lg:max-h-none">
          <div className="px-3 py-2 border-b border-border text-xs font-medium text-muted-foreground shrink-0">
            Describe what this module should do
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2">
            {chat.length === 0 && (
              <p className="text-xs text-muted-foreground">
                e.g. “Take a list of CRM contact rows, drop rows without an
                email, dedupe by email keeping the newest, and return the
                cleaned list plus a dropped count.”
              </p>
            )}
            {chat.map((turn, i) => (
              <div
                key={i}
                className={`text-xs rounded-lg px-3 py-2 max-w-[95%] ${
                  turn.role === "user"
                    ? "bg-primary/10 text-foreground ml-auto"
                    : "bg-secondary text-foreground"
                }`}
              >
                {turn.content}
              </div>
            ))}
            {generating && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Generating…
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <div className="p-3 border-t border-border shrink-0">
            <div className="flex gap-2">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onGenerate();
                  }
                }}
                rows={2}
                placeholder={code ? "Refine the module…" : "Describe the task…"}
                className="flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <button
                onClick={onGenerate}
                disabled={generating || !prompt.trim()}
                className="self-end rounded-lg bg-primary p-2 text-primary-foreground hover:opacity-90 tech-transition disabled:opacity-50"
                title="Generate"
              >
                <Sparkles className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Code + test */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 flex-wrap">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="module_name"
              className="rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs font-mono text-foreground w-44 focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full border ${STATUS_BADGE[status] ?? STATUS_BADGE.draft}`}
            >
              {status}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <button
                onClick={onTest}
                disabled={!code || testing}
                className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-secondary tech-transition flex items-center gap-1 disabled:opacity-50"
              >
                {testing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                Test
              </button>
              <button
                onClick={onSave}
                disabled={!code || !name.trim() || saving}
                className="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 tech-transition flex items-center gap-1 disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                Save
              </button>
              {selectedId && (
                <>
                  <button
                    onClick={onToggleReady}
                    className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-secondary tech-transition flex items-center gap-1"
                    title={
                      status === "ready"
                        ? "Back to draft"
                        : "Mark ready for workflows"
                    }
                  >
                    <Check className="w-3.5 h-3.5" />
                    {status === "ready" ? "Unready" : "Mark ready"}
                  </button>
                  <button
                    onClick={onDelete}
                    className="rounded-lg border border-border p-1.5 text-muted-foreground hover:text-destructive hover:bg-secondary tech-transition"
                    title="Delete module"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>
          {notice && (
            <div className="px-3 py-1.5 text-[11px] text-muted-foreground border-b border-border shrink-0">
              {notice}
            </div>
          )}
          <div className="flex-1 min-h-0">
            <Editor
              height="100%"
              language="python"
              theme={resolvedTheme === "light" ? "light" : "vs-dark"}
              value={code}
              onChange={(v) => setCode(v ?? "")}
              options={{
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
                wordWrap: "on",
              }}
            />
          </div>
          <div className="border-t border-border shrink-0 grid grid-cols-2 h-36">
            <div className="border-r border-border flex flex-col min-w-0">
              <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground border-b border-border">
                Test input (JSON)
              </div>
              <textarea
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                className="flex-1 resize-none bg-background px-3 py-2 text-[11px] font-mono text-foreground focus:outline-none"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col min-w-0">
              <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground border-b border-border">
                Output
              </div>
              <pre className="flex-1 overflow-auto scrollbar-thin px-3 py-2 text-[11px] font-mono text-foreground whitespace-pre-wrap">
                {testResult ?? "Run a test to see the module's output."}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
