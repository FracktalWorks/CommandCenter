import { NextRequest, NextResponse } from "next/server";

const GATEWAY = process.env.GATEWAY_BASE_URL ?? "http://localhost:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

// Provider → env-var map (mirrors settings.py _PROVIDER_ENV_MAP).
// Used as a fallback when the gateway rejects the provider because it's
// running old code that predates the new provider entries.
const PROVIDER_ENV_MAP: Record<string, string> = {
  gemini:     "GEMINI_API_KEY",
  openai:     "OPENAI_API_KEY",
  anthropic:  "ANTHROPIC_API_KEY",
  deepseek:   "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  github:     "GITHUB_TOKEN",
  groq:       "GROQ_API_KEY",
  mistral:    "MISTRAL_API_KEY",
  together:   "TOGETHER_API_KEY",
};

export async function POST(req: NextRequest) {
  const body = await req.json() as { provider?: string; api_key?: string };
  const provider = body.provider ?? "";
  const apiKey   = body.api_key ?? "";

  // ── Primary path: delegate to gateway ────────────────────────────────────
  try {
    const r = await fetch(`${GATEWAY}/settings/llm/key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    const data = await r.json().catch(() => ({}));

    // Gateway accepted → done
    if (r.ok) return NextResponse.json(data);

    // Gateway rejected with "No env var for provider" — gateway is running old
    // code that doesn't know this provider yet.  Fall through to the direct path.
    const detail = String((data as Record<string, unknown>)?.detail ?? "");
    if (!detail.includes("No env var for provider")) {
      return NextResponse.json(data, { status: r.status });
    }
  } catch (_e) {
    // Gateway unreachable — fall through to direct path
  }

  // ── Fallback: write env var directly via /integrations/configure ──────────
  // This endpoint has always existed and accepts arbitrary env-var writes.
  const envVar = PROVIDER_ENV_MAP[provider];
  if (!envVar) {
    return NextResponse.json(
      { detail: `Unknown provider: ${provider}` },
      { status: 400 }
    );
  }
  if (!apiKey.trim()) {
    return NextResponse.json({ detail: "api_key cannot be empty" }, { status: 400 });
  }

  try {
    const r2 = await fetch(`${GATEWAY}/integrations/configure`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({ vars: [{ key: envVar, value: apiKey.trim() }] }),
      signal: AbortSignal.timeout(8_000),
    });
    const data2 = await r2.json().catch(() => ({}));
    if (!r2.ok) {
      return NextResponse.json(data2, { status: r2.status });
    }
    return NextResponse.json({ ok: "true", env_var: envVar, provider });
  } catch (err) {
    return NextResponse.json({ detail: String(err) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const provider = searchParams.get("provider") ?? "";

  if (!provider) {
    return NextResponse.json({ detail: "provider param required" }, { status: 400 });
  }

  try {
    const r = await fetch(`${GATEWAY}/settings/llm/key`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({ provider }),
      signal: AbortSignal.timeout(8_000),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return NextResponse.json(data);
    return NextResponse.json(data, { status: r.status });
  } catch (err) {
    return NextResponse.json({ detail: String(err) }, { status: 502 });
  }
}
