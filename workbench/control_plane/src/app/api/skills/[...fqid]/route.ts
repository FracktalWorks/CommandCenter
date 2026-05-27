import { NextResponse } from "next/server";
import { getSkill, saveSkill } from "@/lib/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ fqid: string[] }> };

function splitFqid(parts: string[]): { domain: string; skill_id: string } | null {
  if (!parts || parts.length !== 2) return null;
  const [domain, skill_id] = parts;
  if (!domain || !skill_id) return null;
  return { domain, skill_id };
}

export async function GET(_req: Request, ctx: Ctx) {
  const { fqid } = await ctx.params;
  const s = splitFqid(fqid);
  if (!s) return NextResponse.json({ error: "bad_fqid" }, { status: 400 });
  const skill = await getSkill(s.domain, s.skill_id);
  if (!skill) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ skill });
}

export async function PUT(req: Request, ctx: Ctx) {
  const { fqid } = await ctx.params;
  const s = splitFqid(fqid);
  if (!s) return NextResponse.json({ error: "bad_fqid" }, { status: 400 });
  const body = (await req.json()) as { raw?: string };
  if (typeof body.raw !== "string" || body.raw.length === 0) {
    return NextResponse.json({ error: "raw_required" }, { status: 400 });
  }
  if (body.raw.length > 200_000) {
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }
  const result = await saveSkill(s.domain, s.skill_id, body.raw);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  // Return the parsed version after save.
  const skill = await getSkill(s.domain, s.skill_id);
  return NextResponse.json({ ok: true, skill });
}