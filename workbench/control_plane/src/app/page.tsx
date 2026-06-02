import Link from "next/link";

const CARDS = [
  { href: "/skills",        title: "Skill Studio",    body: "Browse, author, and evaluate skills under skills/<domain>/<id>/SKILL.md. Backed by OpenHands." },
  { href: "/workflows",     title: "Workflow Editor", body: "LangGraph workflow engine with React Flow canvas — coming in L3." },
  { href: "/observability", title: "Observability",   body: "Audit events, escalation queue, LangGraph traces, LiteLLM spend." },
];

export default function Home() {
  return (
    <div className="p-10 max-w-5xl">
      <h1 className="text-3xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-2 text-zinc-400">
        The Workbench is where skills are authored, workflows are wired up, and the AI Company Brain is observed.
      </p>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 hover:border-zinc-600 transition-colors"
          >
            <div className="text-lg font-medium">{c.title}</div>
            <p className="mt-2 text-sm text-zinc-400">{c.body}</p>
            <div className="mt-4 text-xs text-zinc-500">Open &rarr;</div>
          </Link>
        ))}
      </div>
      <div className="mt-12 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 text-sm text-zinc-400">
        <b>Phase 0.5:</b> Skill Studio, Workflow Editor, and AI chat overlay are live. Google SSO activates once <code>AUTH_GOOGLE_ID</code> / <code>AUTH_GOOGLE_SECRET</code> are set in <code>.env.local</code>.
      </div>
    </div>
  );
}