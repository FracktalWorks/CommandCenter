/**
 * POST /api/artifacts/compile
 *
 * Bundles an agent-authored React component into one self-contained IIFE that
 * the artifact sandbox can run offline (see lib/compileArtifact).
 *
 * The bundling itself is the security-sensitive part and is handled there: the
 * source is untrusted model output, and only an allowlisted React runtime may be
 * imported, so no caller-supplied path ever reaches the filesystem resolver.
 *
 * Compilation is deterministic for a given input, so responses are cached
 * immutably by content hash — a re-render of the same artifact (theme flip, tab
 * switch, chat scroll-back) never recompiles.
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

import { compileArtifact } from "@/lib/compileArtifact";
import { requireIdentity } from "@/lib/gateway";

export const dynamic = "force-dynamic";
// esbuild is a native binary — it cannot run on the edge runtime.
export const runtime = "nodejs";

/** Guard against a runaway or malicious source pinning a server thread. */
const COMPILE_TIMEOUT_MS = 10_000;

export async function POST(request: Request): Promise<NextResponse> {
  // Bundling is CPU-bound and caller-driven, so it needs a member behind
  // it even though `/api/artifacts/` is not in the proxy's public list.
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  let code: unknown;
  try {
    ({ code } = (await request.json()) as { code?: unknown });
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be JSON." }, { status: 400 });
  }
  if (typeof code !== "string") {
    return NextResponse.json(
      { ok: false, error: "Expected a `code` string." },
      { status: 400 },
    );
  }

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Compile timed out.")), COMPILE_TIMEOUT_MS),
  );

  try {
    const result = await Promise.race([compileArtifact(code), timeout]);
    if (!result.ok) {
      // A compile error is the agent's bug to fix, not a server fault — 200 with
      // ok:false so the client renders the diagnostics instead of a network error.
      return NextResponse.json(result);
    }
    const etag = `"${createHash("sha256").update(result.js).digest("hex").slice(0, 32)}"`;
    return NextResponse.json(result, {
      headers: { ETag: etag, "Cache-Control": "private, max-age=31536000, immutable" },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Compile failed." },
      { status: 500 },
    );
  }
}
