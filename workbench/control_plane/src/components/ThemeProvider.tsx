"use client";

/**
 * ThemeProvider — runtime half of the theming engine.
 *
 * Renders nothing. Three jobs, all side effects:
 *
 *   1. Read the member's stored preferences into the store on mount. The boot
 *      script has already applied them to the DOM; this is what tells React
 *      about them.
 *   2. Fetch the organisation's defaults so a member who has never opened
 *      Settings still gets the company look, and cache them locally so the
 *      boot script can apply them on the next load with no flash.
 *   3. Preload the active theme's icon pack, so themed glyphs are ready
 *      before the first `<Icon>` needs them rather than after.
 */

import { useEffect } from "react";
import { useAppearanceStore, effectiveThemeId } from "@/lib/theme/store";
import { ensureIconPack } from "@/lib/theme/icon-packs";
import { resolveTheme } from "@/lib/theme/themes";
import type { AppearanceSettings } from "@/lib/theme/types";

export default function ThemeProvider() {
  const hydrate = useAppearanceStore((s) => s.hydrate);
  const setOrgDefaults = useAppearanceStore((s) => s.setOrgDefaults);
  const themeId = useAppearanceStore(effectiveThemeId);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/settings/appearance", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: AppearanceSettings | null) => {
        if (data?.org) setOrgDefaults(data.org);
      })
      .catch(() => {
        // Signed out, offline, or the gateway is down — the cached org
        // defaults the boot script already applied remain in force.
      });
    return () => controller.abort();
  }, [setOrgDefaults]);

  useEffect(() => {
    ensureIconPack(resolveTheme(themeId).iconPack);
  }, [themeId]);

  return null;
}
