import Link from "next/link";
import { getSkill } from "@/lib/skills";
import SkillEditor from "@/components/SkillEditor";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ fqid: string[] }> };

export default async function SkillDetail({ params }: Props) {
  const { fqid } = await params;
  if (fqid.length !== 2) {
    return <div className="p-10 text-red-400">Invalid skill URL: {fqid.join("/")}</div>;
  }
  const [domain, skill_id] = fqid;
  const skill = await getSkill(domain, skill_id);
  if (!skill) {
    return (
      <div className="p-10">
        <Link href="/skills" className="text-sm text-blue-400 hover:underline">&larr; back to catalogue</Link>
        <h1 className="mt-4 text-2xl font-semibold">Skill not found</h1>
        <p className="mt-2 text-zinc-400 font-mono">{domain}/{skill_id}</p>
      </div>
    );
  }
  return (
    <SkillEditor
      fqid={skill.fqid}
      relPath={skill.relPath}
      initialRaw={skill.raw}
      authority={skill.authority}
      rollout={skill.rollout_stage}
      version={skill.version}
      openhandsUrl={process.env.NEXT_PUBLIC_OPENHANDS_URL ?? "http://localhost:3000"}
    />
  );
}