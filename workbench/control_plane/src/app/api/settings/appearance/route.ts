/**
 * GET /api/settings/appearance — the organisation's appearance defaults
 * PUT /api/settings/appearance — update them (admin-only, enforced upstream)
 *
 * Only the ORGANISATION half lives here. A member's own theme, density and
 * accent stay in their browser: they are per-device preferences with no
 * server-side consequence, and round-tripping them would add a request to
 * every page load to render something the boot script has already applied.
 *
 * The gateway may not have an appearance store yet. Rather than failing the
 * page, GET falls back to the built-in defaults and reports `orgManaged:
 * false`, which is what Settings uses to explain that the org-wide controls
 * are unavailable in this deployment.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  GATEWAY_URL,
  NoIdentityError,
  gatewayHeaders,
  requireIdentity,
  unauthenticated,
} from "@/lib/gateway";
import { DEFAULT_THEME_ID, findTheme } from "@/lib/theme/themes";
import { isSafeColor } from "@/lib/theme/css";
import { DENSITY_SCALE } from "@/lib/theme/types";
import type { AppearanceSettings, Density, ThemeMode } from "@/lib/theme/types";

export const dynamic = "force-dynamic";

const GATEWAY_PATH = "/settings/appearance";

const BUILTIN_DEFAULTS: AppearanceSettings["org"] = {
  themeId: DEFAULT_THEME_ID,
  mode: "dark",
  density: "default",
  allowUserOverride: true,
};

const EMPTY_USER: AppearanceSettings["user"] = {
  themeId: null,
  mode: null,
  density: null,
  accent: null,
};

function isMode(v: unknown): v is ThemeMode {
  return v === "dark" || v === "light";
}

function isDensity(v: unknown): v is Density {
  return typeof v === "string" && v in DENSITY_SCALE;
}

/**
 * Coerce whatever the gateway returned into a usable org default.
 *
 * Every field is validated rather than trusted: a theme id that no longer
 * exists (removed, renamed, or from a newer deployment) would otherwise put
 * `data-theme` into a state no stylesheet matches, leaving the app unstyled.
 * Unrecognised values fall back field by field, so one bad key does not
 * discard an otherwise good response.
 */
function normaliseOrg(raw: unknown): AppearanceSettings["org"] {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    themeId: findTheme(String(o.themeId ?? "")) ? String(o.themeId) : BUILTIN_DEFAULTS.themeId,
    mode: isMode(o.mode) ? o.mode : BUILTIN_DEFAULTS.mode,
    density: isDensity(o.density) ? o.density : BUILTIN_DEFAULTS.density,
    allowUserOverride:
      typeof o.allowUserOverride === "boolean"
        ? o.allowUserOverride
        : BUILTIN_DEFAULTS.allowUserOverride,
  };
}

export async function GET(): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;

  try {
    const res = await fetch(`${GATEWAY_URL}${GATEWAY_PATH}`, {
      headers: await gatewayHeaders(),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({
        org: normaliseOrg(data?.org ?? data),
        user: EMPTY_USER,
        orgManaged: true,
      } satisfies AppearanceSettings);
    }
  } catch {
    // Gateway unreachable or timed out — fall through to the built-in default.
  }

  return NextResponse.json({
    org: BUILTIN_DEFAULTS,
    user: EMPTY_USER,
    orgManaged: false,
  } satisfies AppearanceSettings);
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const input = (body ?? {}) as Record<string, unknown>;

  // Validate here rather than forwarding blindly: these values end up driving
  // a CSS selector and a colour declaration for every member of the org, so a
  // bad write is a broken app for everyone, not just the admin who made it.
  if (input.themeId !== undefined && !findTheme(String(input.themeId))) {
    return NextResponse.json({ error: `Unknown theme: ${String(input.themeId)}` }, { status: 400 });
  }
  if (input.mode !== undefined && !isMode(input.mode)) {
    return NextResponse.json({ error: "mode must be 'dark' or 'light'" }, { status: 400 });
  }
  if (input.density !== undefined && !isDensity(input.density)) {
    return NextResponse.json(
      { error: `density must be one of ${Object.keys(DENSITY_SCALE).join(", ")}` },
      { status: 400 },
    );
  }
  if (
    input.accent !== undefined &&
    input.accent !== null &&
    !isSafeColor(String(input.accent))
  ) {
    return NextResponse.json({ error: "accent must be a plain CSS colour" }, { status: 400 });
  }

  // Whether the caller may set an org-wide default is an authorization
  // question, and authorization is resolved from the org tables at the
  // gateway — not from anything this request could assert.
  try {
    const res = await fetch(`${GATEWAY_URL}${GATEWAY_PATH}`, {
      method: "PUT",
      headers: await gatewayHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(8_000),
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (err) {
    if (err instanceof NoIdentityError) return unauthenticated();
    return NextResponse.json(
      { error: "Appearance defaults are not available in this deployment" },
      { status: 503 },
    );
  }
}
