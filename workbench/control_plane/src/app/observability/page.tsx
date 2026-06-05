export default function Observability() {
  return (
    <div className="p-10 max-w-6xl">
      <h1 className="text-3xl font-semibold tracking-tight">Observability</h1>
      <p className="mt-2 text-zinc-400">
        Audit events, escalation queue, agent traces (OTel), LiteLLM spend (Phase 0.5.6+).
      </p>
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {["Open escalations", "Skills used today", "LiteLLM spend (USD)"].map((label) => (
          <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
            <div className="text-xs uppercase text-zinc-500">{label}</div>
            <div className="mt-2 text-3xl font-semibold">--</div>
          </div>
        ))}
      </div>
      <div className="mt-8 rounded-lg border border-zinc-800 bg-zinc-900/30 p-6">
        <div className="text-sm font-medium">Audit event tail</div>
        <pre className="mt-3 max-h-64 overflow-auto rounded bg-black/60 p-3 font-mono text-xs text-zinc-400">
          {"// /api/audit?tail=50  (Phase 0.5.6)\n[stub]\n"}
        </pre>
      </div>
    </div>
  );
}