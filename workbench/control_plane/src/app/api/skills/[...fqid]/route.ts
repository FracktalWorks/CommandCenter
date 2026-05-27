import { NextResponse } from "next/server";
import { execSync } from "node:child_process";
import path from "node:path";
import { getSkill, saveSkill, skillsRoot } from "@/lib/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ fqid: string[] }> };

function splitFqid(parts: string[]): { domain: string; skill_id: string } | null {
  if (!parts || parts.length !== 2) return null;
  const [domain, skill_id] = parts;
  if (!domain || !skill_id) return null;
  return { domain, skill_id };
}

/** Repo root is the parent of the skills/ directory. */
function repoRoot(): string {
  return path.resolve(skillsRoot(), "..");
}

export async function GET(_req: Request, ctx: Ctx) {
  const { fqid } = await ctx.params;

  // GET /api/skills/<domain>/<skill_id>/diff — returns git diff vs HEAD
  if (fqid.length === 3 && fqid[2] === "diff") {
    const s = splitFqid([fqid[0], fqid[1]]);
    if (!s) return NextResponse.json({ error: "bad_fqid" }, { status: 400 });
    const skill = await getSkill(s.domain, s.skill_id);
    if (!skill) return NextResponse.json({ error: "not_found" }, { status: 404 });
    try {
      // relPath is validated/constructed by the skills lib — safe to pass to git
      const diff = execSync(`git diff HEAD -- "${skill.relPath}"`, {
        cwd: repoRoot(),
        encoding: "utf8",
        timeout: 8000,
      });
      return NextResponse.json({ diff: diff ?? "", clean: !diff.trim() });
    } catch (e) {
      return NextResponse.json({ diff: "", clean: true, error: (e as Error).message });
    }
  }

  // Standard GET /api/skills/<domain>/<skill_id>
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
  const skill = await getSkill(s.domain, s.skill_id);
  return NextResponse.json({ ok: true, skill });
}

export async function POST(_req: Request, ctx: Ctx) {
  const { fqid } = await ctx.params;

  // POST /api/skills/<domain>/<skill_id>/pr — branch + commit + optional push
  if (fqid.length === 3 && fqid[2] === "pr") {
    const s = splitFqid([fqid[0], fqid[1]]);
    if (!s) return NextResponse.json({ error: "bad_fqid" }, { status: 400 });
    const skill = await getSkill(s.domain, s.skill_id);
    if (!skill) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const root = repoRoot();
    const slug = `${s.domain}-${s.skill_id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const branch = `skill/${slug}/${Date.now()}`;

    try {
      // Abort if nothing to commit
      const porcelain = execSync(`git status --porcelain -- "${skill.relPath}"`, {
        cwd: root, encoding: "utf8", timeout: 5000,
      }).trim();
      if (!porcelain) {
        return NextResponse.json({ ok: false, error: "no_changes" });
      }

      execSync(`git checkout -b "${branch}"`, { cwd: root, timeout: 5000 });
      execSync(`git add -- "${skill.relPath}"`, { cwd: root, timeout: 5000 });
      execSync(
        `git commit -m "skill(${skill.fqid}): update SKILL.md via Skill Studio"`,
        { cwd: root, timeout: 5000 },
      );
      const hash = execSync("git rev-parse --short HEAD", {
        cwd: root, encoding: "utf8", timeout: 5000,
      }).trim();

      // Build GitHub PR URL from remote (non-fatal if absent)
      let prUrl: string | null = null;
      try {
        const remote = execSync("git remote get-url origin", {
          cwd: root, encoding: "utf8", timeout: 5000,
        }).trim();
        const base = remote
          .replace(/^git@github\.com:/, "https://github.com/")
          .replace(/\.git$/, "");
        prUrl = `${base}/compare/${branch}?expand=1`;
      } catch { /* no remote configured */ }

      // Try to push (non-fatal — user can push manually)
      let pushed = false;
      try {
        execSync(`git push -u origin "${branch}"`, { cwd: root, timeout: 20000 });
        pushed = true;
      } catch { /* push failed */ }

      return NextResponse.json({
        ok: true,
        branch,
        hash,
        pushed,
        prUrl,
        pushCmd: `git push -u origin ${branch}`,
      });
    } catch (e) {
      return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "not_found" }, { status: 404 });
}