import { NextResponse } from "next/server";
import { listSkills } from "@/lib/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const includeExamples = url.searchParams.get("include_examples") === "1";
  const skills = await listSkills({ includeExamples });
  return NextResponse.json({ skills });
}