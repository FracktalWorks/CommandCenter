import Link from "next/link";

const CARDS = [
  { href: "/chat",          title: "Chat",          body: "Talk to CommandCenter. Sessions are isolated by threadId; persistent memory via Mem0 feeds back into agents over time." },
];

export default function Home() {
  return (
    <div className="p-6 sm:p-10 max-w-5xl">
      <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-2 text-muted-foreground">
        Chat with CommandCenter or observe what the agents are doing.
      </p>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="rounded-lg border border-border bg-card/50 p-5 hover:border-primary/30 transition-colors"
          >
            <div className="text-lg font-medium">{c.title}</div>
            <p className="mt-2 text-sm text-muted-foreground">{c.body}</p>
            <div className="mt-4 text-xs text-muted-foreground">Open &rarr;</div>
          </Link>
        ))}
      </div>
      <div className="mt-12 rounded-lg border border-border bg-card/30 p-4 text-sm text-muted-foreground">
        <b>Phase 1:</b> Self-Mutation Loop. Sign in with your Microsoft 365 account via the sidebar.
      </div>
    </div>
  );
}