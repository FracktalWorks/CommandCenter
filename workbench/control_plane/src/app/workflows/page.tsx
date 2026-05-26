export default function WorkflowEditor() {
  return (
    <div className="p-10 max-w-6xl">
      <h1 className="text-3xl font-semibold tracking-tight">Workflow Editor</h1>
      <p className="mt-2 text-zinc-400">
        n8n embedded via iframe with session-cookie passthrough (Phase 0.5.5).
      </p>
      <div className="mt-8 rounded-lg border border-dashed border-zinc-700 bg-zinc-900/30 p-12 text-center text-zinc-500">
        n8n iframe slot
        <div className="mt-2 text-xs">URL: http://n8n.local (TBD)</div>
      </div>
    </div>
  );
}