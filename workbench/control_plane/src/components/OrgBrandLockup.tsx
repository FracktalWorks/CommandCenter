"use client";

/**
 * The top-left of the app: the customer's logo, "powered by CommandCenter".
 *
 * There are two shells — the desktop sidebar and the mobile menu — and this
 * component exists so there is one lockup rather than two. The last time a
 * visual element was written twice in this tree the copies drifted, and a brand
 * mark that renders differently depending on window width is worse than no
 * brand mark at all.
 *
 * The fallback is not an afterthought: an organisation that has uploaded
 * nothing gets our own mark, deliberately, and it must look finished rather
 * than like a logo that failed to load. `lockup()` in `lib/orgBranding.ts`
 * owns that decision and is tested for it.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import Icon from "@/components/Icon";
import {
  type OrgBranding,
  lockup,
  logoBoxWidth,
} from "@/lib/orgBranding";

// ── One fetch per page load, shared by both shells ─────────────────────────
//
// The desktop sidebar and the mobile menu are mounted at the same time on a
// tablet-width viewport. A naive `useEffect(fetch)` in each would issue two
// identical requests on every navigation; the module-level cache collapses them
// to one, and the in-flight promise collapses the concurrent case that a plain
// value cache still misses.

let cached: OrgBranding | null = null;
let inFlight: Promise<OrgBranding> | null = null;

async function fetchBranding(): Promise<OrgBranding> {
  const res = await fetch("/api/settings/branding", { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as OrgBranding;
}

/** Drop the cache so a fresh upload shows up without a reload. */
export function invalidateOrgBranding(next?: OrgBranding): void {
  cached = next ?? null;
  inFlight = null;
  for (const listener of listeners) listener(cached);
}

const listeners = new Set<(b: OrgBranding | null) => void>();

export function useOrgBranding(): OrgBranding | null {
  const [branding, setBranding] = useState<OrgBranding | null>(cached);

  useEffect(() => {
    let alive = true;
    listeners.add(setBranding);

    if (cached === null) {
      inFlight ??= fetchBranding().catch(() => ({
        // A failed read renders our own mark, which is also what an org with no
        // logo gets. There is nothing here for a member to act on, so it is not
        // surfaced as an error state.
        logo: null,
        updatedBy: "",
        updatedAt: "",
      }));
      void inFlight.then((b) => {
        cached = b;
        if (alive) setBranding(b);
      });
    }

    return () => {
      alive = false;
      listeners.delete(setBranding);
    };
  }, []);

  return branding;
}

interface Props {
  /** Subtitle shown when the org has no logo — "Control Plane", "Home", … */
  fallbackCaption: string;
  /** Where the mark links to. Both shells send it home. */
  href?: string;
  onNavigate?: () => void;
  /** Height of the mark in px. The two shells differ by a hair. */
  height?: number;
  /** Widest the logo may render before it starts crowding the nav controls. */
  maxWidth?: number;
}

export default function OrgBrandLockup({
  fallbackCaption,
  href = "/",
  onNavigate,
  height = 28,
  maxWidth = 152,
}: Props) {
  const branding = useOrgBranding();
  const mark = lockup(branding, fallbackCaption);

  return (
    <Link
      href={href}
      onClick={onNavigate}
      className="flex min-w-0 items-center gap-2.5"
    >
      {mark.kind === "org" ? (
        // A `data:` URI from our own gateway, whose MIME type was derived from
        // the file's magic bytes rather than from anything the uploader
        // declared. `next/image` has nothing to optimise here and would only
        // add a loader round-trip to bytes we already hold.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={mark.logo.dataUri}
          alt={mark.alt}
          style={{
            height,
            width: logoBoxWidth(mark.logo, height, maxWidth),
          }}
          className="shrink-0 object-contain object-left"
        />
      ) : (
        <span
          className="flex shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
          style={{ height, width: height }}
        >
          <Icon name="Command" size={Math.round(height * 0.54)} strokeWidth={2.5} />
        </span>
      )}

      <div className="min-w-0">
        {mark.kind === "default" ? (
          <div className="truncate text-sm font-semibold leading-tight tracking-tight text-sidebar-foreground">
            {mark.title}
          </div>
        ) : null}
        {/* Ours sits under theirs, quietly. It is attribution, not branding —
            at `text-[10px]` on muted it reads as a byline, which is the whole
            point of the arrangement. */}
        <div className="truncate text-[10px] leading-tight text-muted-foreground">
          {mark.caption}
        </div>
      </div>
    </Link>
  );
}
