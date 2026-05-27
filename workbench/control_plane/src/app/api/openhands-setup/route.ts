import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/openhands-setup
 *
 * Idempotent bootstrap: seeds the OpenHands settings database with the
 * local LiteLLM proxy config (Gemini 2.5 Pro via tier3-opus) so the user
 * never has to touch the Settings UI.
 *
 * Safe to call on every Skill Editor page load — exits early if settings
 * are already present.
 */

const OH_URL = process.env.OPENHANDS_BASE_URL ?? "http://127.0.0.1:3002";
const LITELLM_KEY = process.env.LITELLM_MASTER_KEY ?? "sk-local-dev-change-me";

// From inside the OpenHands Docker container, LiteLLM is at host.docker.internal.
const LITELLM_URL_IN_DOCKER = "http://host.docker.internal:4000";
const LLM_MODEL = "tier3-opus";

export async function GET() {
  try {
    // ── 1. Check if already configured ───────────────────────────────────────
    const checkRes = await fetch(`${OH_URL}/api/settings`, {
      cache: "no-store",
    });
    if (checkRes.ok) {
      // Settings already exist — nothing to do
      return NextResponse.json({ ok: true, seeded: false });
    }
    if (checkRes.status !== 404) {
      // Unexpected error (e.g. OpenHands not running)
      return NextResponse.json(
        { ok: false, reason: `settings check returned ${checkRes.status}` },
        { status: 502 },
      );
    }

    // ── 2. Seed initial settings ──────────────────────────────────────────────
    const seedRes = await fetch(`${OH_URL}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm_model: LLM_MODEL,
        llm_api_key: LITELLM_KEY,
        llm_base_url: LITELLM_URL_IN_DOCKER,
        user_consents_to_analytics: false,
        enable_default_condenser: true,
      }),
      cache: "no-store",
    });
    if (!seedRes.ok) {
      const err = await seedRes.text();
      return NextResponse.json(
        { ok: false, reason: `seed failed (${seedRes.status}): ${err}` },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, seeded: true });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 502 });
  }
}
