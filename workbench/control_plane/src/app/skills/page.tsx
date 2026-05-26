async function loadSkills() {
  // TODO Phase 0.5.4: call /api/skills (backed by acb_skills loader).
  return [
    { fqid: "sales/quiet_deal_followup", authority: "suggest", stage: "shadow", version: "0.1.0" },
    { fqid: "delivery/stale_task_nudge", authority: "suggest", stage: "shadow", version: "0.1.0" },
  ];
}

export default async function SkillStudio() {
  const skills = await loadSkills();
  return (
    <div className="p-10 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Skill Studio</h1>
          <p className="mt-2 text-zinc-400">Catalogue + Monaco editor + OpenHands iframe (Phase 0.5.4).</p>
        </div>
        <button className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm hover:bg-zinc-700">
          + New skill
        </button>
      </div>
      <table className="mt-8 w-full text-sm">
        <thead className="text-left text-xs uppercase text-zinc-500">
          <tr>
            <th className="py-2">Skill</th>
            <th>Authority</th>
            <th>Rollout</th>
            <th>Version</th>
          </tr>
        </thead>
        <tbody>
          {skills.map((s) => (
            <tr key={s.fqid} className="border-t border-zinc-800">
              <td className="py-3 font-mono">{s.fqid}</td>
              <td className="text-zinc-400">{s.authority}</td>
              <td className="text-zinc-400">{s.stage}</td>
              <td className="text-zinc-400">{s.version}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-8 text-xs text-zinc-600">
        Stub data. Real listing lands in Phase 0.5.4 via the <code>acb_skills</code> loader exposed over an internal API route.
      </p>
    </div>
  );
}