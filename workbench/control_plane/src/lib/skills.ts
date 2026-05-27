import fs from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

export type Frontmatter = {
  name: string;
  description?: string;
  when_to_use?: string;
  domain?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  allowed_tools?: string[];
  authority?: "read" | "suggest" | "suggest_apply" | "autonomous";
  cost_tier?: number;
  version?: string;
  provenance?: string;
  rollout_stage?: "shadow" | "canary" | "live" | "retired";
  success_rate_30d?: number | null;
  cases_seen_30d?: number;
  [k: string]: unknown;
};

export type SkillSummary = {
  fqid: string;          // "<domain>/<skill_id>"
  domain: string;
  skill_id: string;
  authority: string;
  rollout_stage: string;
  version: string;
  description: string;
};

export type SkillDetail = SkillSummary & {
  frontmatter: Frontmatter;
  body: string;
  raw: string;            // full SKILL.md text
  relPath: string;        // posix-style, relative to repo root
};

/** Repo root = three levels up from workbench/control_plane/.next/server (build) or src/. */
export function skillsRoot(): string {
  const fromEnv = process.env.SKILLS_ROOT;
  if (fromEnv) return path.resolve(fromEnv);
  // cwd is workbench/control_plane when `next dev`/`next start` runs.
  return path.resolve(process.cwd(), "..", "..", "skills");
}

function walkSync(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name === "SKILL.md") out.push(p);
    }
  }
  return out;
}

function parseSkill(absPath: string, root: string): SkillDetail | null {
  // path layout: <root>/<domain>/<skill_id>/SKILL.md
  const rel = path.relative(root, absPath).split(path.sep);
  if (rel.length < 3) return null;
  const [domain, skill_id] = rel;
  // Exclude reserved trees by default.
  if (domain === "upstream") return null;

  const raw = readFileSync(absPath, "utf8");
  const parsed = matter(raw);
  const fm = parsed.data as Frontmatter;
  const fqid = `${domain}/${skill_id}`;
  return {
    fqid,
    domain,
    skill_id,
    authority: fm.authority ?? "read",
    rollout_stage: fm.rollout_stage ?? "shadow",
    version: fm.version ?? "0.0.0",
    description: fm.description ?? "",
    frontmatter: fm,
    body: parsed.content,
    raw,
    relPath: path.posix.join("skills", domain, skill_id, "SKILL.md"),
  };
}

export async function listSkills(opts: { includeExamples?: boolean } = {}): Promise<SkillSummary[]> {
  const root = skillsRoot();
  const files = walkSync(root);
  const all: SkillSummary[] = [];
  for (const f of files) {
    const s = parseSkill(f, root);
    if (!s) continue;
    if (!opts.includeExamples && s.domain === "examples") continue;
    const { fqid, domain, skill_id, authority, rollout_stage, version, description } = s;
    all.push({ fqid, domain, skill_id, authority, rollout_stage, version, description });
  }
  all.sort((a, b) => a.fqid.localeCompare(b.fqid));
  return all;
}

export async function getSkill(domain: string, skill_id: string): Promise<SkillDetail | null> {
  const root = skillsRoot();
  // Defensive: prevent path traversal.
  if (domain.includes("..") || skill_id.includes("..") || domain.includes("/") || skill_id.includes("/")) {
    return null;
  }
  const p = path.join(root, domain, skill_id, "SKILL.md");
  try { await fs.access(p); } catch { return null; }
  return parseSkill(p, root);
}

export async function saveSkill(domain: string, skill_id: string, raw: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const root = skillsRoot();
  if (domain.includes("..") || skill_id.includes("..") || domain.includes("/") || skill_id.includes("/")) {
    return { ok: false, error: "invalid_path" };
  }
  // Validate it parses as frontmatter + body.
  try {
    const parsed = matter(raw);
    const fm = parsed.data as Frontmatter;
    if (!fm.name) return { ok: false, error: "frontmatter missing 'name'" };
  } catch (e) {
    return { ok: false, error: `frontmatter parse error: ${(e as Error).message}` };
  }
  const dir = path.join(root, domain, skill_id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), raw, { encoding: "utf8" });
  return { ok: true };
}