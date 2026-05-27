import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/openhands-seed
 *
 * Pre-seed an OpenHands conversation with a first user message that tells
 * the agent which SKILL.md to open. The Skill Editor calls this on mount
 * with `{ fqid, relPath, description }` and uses the returned conversation_id
 * to switch the iframe from the cold-start root URL to the seeded session.
 *
 * Returns: { ok: true, conversation_id, url } or { ok: false, reason }.
 */

const OH_URL = process.env.OPENHANDS_BASE_URL ?? "http://127.0.0.1:3002";

type Body = {
  fqid: string;
  relPath: string;
  description?: string;
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid json body" }, { status: 400 });
  }

  if (!body.fqid || !body.relPath) {
    return NextResponse.json(
      { ok: false, reason: "fqid and relPath are required" },
      { status: 400 },
    );
  }

  // OpenHands mounts the workspace at /workspace inside the sandbox container.
  const sandboxPath = `/workspace/${body.relPath.replace(/^\/+/, "")}`;
  const initialMsg = [
    `Open ${sandboxPath} and help me improve it.`,
    body.description
      ? `For context, the skill description is: ${body.description}`
      : `It's the skill ${body.fqid}.`,
    `Start by reading the file, then ask me what I'd like to change.`,
  ].join("\n\n");

  try {
    const res = await fetch(`${OH_URL}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initial_user_msg: initialMsg }),
      cache: "no-store",
    });
    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json(
        { ok: false, reason: `openhands ${res.status}: ${err}` },
        { status: 502 },
      );
    }
    const data = (await res.json()) as { conversation_id?: string };
    const cid = data.conversation_id;
    if (!cid) {
      return NextResponse.json(
        { ok: false, reason: "openhands response missing conversation_id" },
        { status: 502 },
      );
    }
    return NextResponse.json({
      ok: true,
      conversation_id: cid,
      url: `${OH_URL}/conversations/${cid}`,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 502 });
  }
}
