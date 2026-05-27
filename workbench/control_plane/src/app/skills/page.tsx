import Link from "next/link";
import { listSkills } from "@/lib/skills";

export const dynamic = "force-dynamic";

const STAGE_COLOR: Record<string, string> = {
  shadow:  "bg-zinc-700 text-zinc-200",
  canary:  "bg-amber-700 text-amber-100",
  live:    "bg-emerald-700 text-emerald-100",
  retired: "bg-red-900 text-red-200",
};

export default async function SkillStudio() {
  const skills = await listSkills();
  return (
    <div className="p-10 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Skill Studio</h1>
          <p className="mt-2 text-zinc-400">
            {skills.length} production skill{skills.length === 1 ? "" : "s"} loaded from <code className="font-mono text-xs">skills/</code>.
          </p>
        </div>
        <a
          href={process.env.NEXT_PUBLIC_OPENHANDS_URL ?? "http://localhost:3000"}
          target="_blank"
          rel="noreferrer"
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm hover:bg-zinc-700"
        >
          Open OpenHands &rarr;
        </a>
      </div>

      <table className="mt-8 w-full text-sm">
        <thead className="text-left text-xs uppercase text-zinc-500">
          <tr>
            <th className="py-2">Skill</th>
            <th>Authority</th>
            <th>Rollout</th>
            <th>Version</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {skills.map((s) => (
            <tr key={s.fqid} className="border-t border-zinc-800 hover:bg-zinc-900/40">
              <td className="py-3">
                <div className="font-mono text-zinc-100">{s.fqid}</div>
                <div className="mt-1 text-xs text-zinc-500 line-clamp-1">{s.description}</div>
              </td>
              <td className="text-zinc-400">{s.authority}</td>
              <td>
                <span className={`rounded px-2 py-0.5 text-xs ${STAGE_COLOR[s.rollout_stage] ?? "bg-zinc-700"}`}>
                  {s.rollout_stage}
                </span>
              </td>
              <td className="text-zinc-400">{s.version}</td>
              <td className="text-right">
                <Link href={`/skills/${s.fqid}`} className="text-sm text-blue-400 hover:underline">
                  edit &rarr;
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {skills.length === 0 && (
        <p className="mt-8 text-sm text-zinc-500">
          No skills found. Check that <code>SKILLS_ROOT</code> points at the repo&apos;s <code>skills/</code> directory.
        </p>
      )}
    </div>
  );
}