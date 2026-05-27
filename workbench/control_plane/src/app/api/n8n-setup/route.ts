import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/n8n-setup
 *
 * Idempotent bootstrap: creates the "LiteLLM (local)" OpenAI-compatible
 * credential in n8n so every AI Agent / LangChain node in the workspace
 * is pre-wired to the local LiteLLM proxy (Gemini 2.5 Pro via tier3-opus).
 *
 * Safe to call on every Workflows page load — it exits early if the
 * credential already exists.
 */

const N8N_URL = process.env.N8N_BASE_URL ?? "http://localhost:5678";
const N8N_EMAIL = process.env.N8N_OWNER_EMAIL ?? "admin@localhost.dev";
const N8N_PASSWORD = process.env.N8N_OWNER_PASSWORD ?? "";

// From inside the n8n Docker container, LiteLLM is reachable via host gateway.
const LITELLM_URL_IN_DOCKER = "http://host.docker.internal:4000";
const LITELLM_KEY = process.env.LITELLM_MASTER_KEY ?? "sk-local-dev-change-me";

const CRED_NAME = "LiteLLM (local)";

export async function GET() {
  try {
    // ── 1. Login ─────────────────────────────────────────────────────────────
    const loginRes = await fetch(`${N8N_URL}/rest/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emailOrLdapLoginId: N8N_EMAIL, password: N8N_PASSWORD }),
      cache: "no-store",
    });
    if (!loginRes.ok) {
      return NextResponse.json(
        { ok: false, reason: `n8n login ${loginRes.status}` },
        { status: 502 },
      );
    }
    const setCookie = loginRes.headers.get("set-cookie") ?? "";
    const tokenMatch = setCookie.match(/n8n-auth=([^;]+)/);
    if (!tokenMatch) {
      return NextResponse.json({ ok: false, reason: "no n8n-auth cookie" }, { status: 502 });
    }
    const authCookie = `n8n-auth=${tokenMatch[1]}`;

    // ── 2. Check if already exists ────────────────────────────────────────────
    const listRes = await fetch(`${N8N_URL}/rest/credentials`, {
      headers: { Cookie: authCookie },
      cache: "no-store",
    });
    if (listRes.ok) {
      const list = await listRes.json();
      const alreadyExists = (list.data ?? []).some(
        (c: { name: string }) => c.name === CRED_NAME,
      );
      if (alreadyExists) {
        return NextResponse.json({ ok: true, created: false });
      }
    }

    // ── 3. Create credential ──────────────────────────────────────────────────
    const createRes = await fetch(`${N8N_URL}/rest/credentials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        name: CRED_NAME,
        type: "openAiApi",
        data: {
          apiKey: LITELLM_KEY,
          url: LITELLM_URL_IN_DOCKER,
        },
      }),
      cache: "no-store",
    });
    if (!createRes.ok) {
      const errBody = await createRes.text();
      return NextResponse.json(
        { ok: false, reason: `credential create failed (${createRes.status}): ${errBody}` },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, created: true });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 502 });
  }
}
