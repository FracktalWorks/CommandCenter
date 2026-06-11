"use client";

/**
 * ViewModeProvider — decides between the mobile and desktop layouts.
 *
 * Behaviour (per the product requirement):
 *   • On a narrow screen (phone) the app renders the clean mobile layout by default.
 *   • The user can explicitly "Request desktop" — we then render the full desktop
 *     layout AND widen the viewport meta to a desktop width so the page is laid out
 *     exactly like the desktop site (pannable / zoomable), mirroring the native
 *     browser "Request Desktop Site" behaviour.
 *   • The preference is persisted in localStorage so it survives reloads.
 *
 * Key trick: when desktop is forced on a narrow device we set the viewport meta to a
 * fixed desktop width (1280). That makes every Tailwind `sm:`/`md:`/`lg:` breakpoint
 * evaluate as "wide", so component-level responsive classes line up automatically
 * with the structural (JS-driven) layout choice exposed via `isMobile`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const NARROW_QUERY = "(max-width: 767px)";
const STORAGE_KEY = "cc-force-desktop";
const DESKTOP_VIEWPORT = "width=1280";
const MOBILE_VIEWPORT = "width=device-width, initial-scale=1, viewport-fit=cover";

type ViewModeContextValue = {
  /** Has the component mounted on the client (media queries are client-only). */
  mounted: boolean;
  /** True when the physical viewport is narrow (phone-sized). */
  isNarrow: boolean;
  /** User has explicitly asked for the desktop layout on a narrow device. */
  forceDesktop: boolean;
  /** Final decision: render the mobile layout. */
  isMobile: boolean;
  /** Switch between mobile and desktop layouts. */
  toggleView: () => void;
  setForceDesktop: (value: boolean) => void;
};

const ViewModeContext = createContext<ViewModeContextValue | null>(null);

function applyViewport(forceDesktopOnNarrow: boolean) {
  if (typeof document === "undefined") return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "viewport";
    document.head.appendChild(meta);
  }
  meta.content = forceDesktopOnNarrow ? DESKTOP_VIEWPORT : MOBILE_VIEWPORT;
}

export default function ViewModeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);

  // Lazy initializers read localStorage + media query once (SSR-safe).
  const [forceDesktop, setForceDesktopState] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  const [isNarrow, setIsNarrow] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(NARROW_QUERY).matches;
  });

  // Subscribe to media query changes on mount.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setMounted(true);
    const mql = window.matchMedia(NARROW_QUERY);
    const onChange = () => setIsNarrow(mql.matches);

    // If the device is narrow but forceDesktop was stuck from a prior
    // session (e.g. user closed tab while in desktop mode), clear it
    // so the mobile layout renders immediately on next visit.
    if (mql.matches) {
      try {
        const stuck = localStorage.getItem(STORAGE_KEY) === "1";
        if (stuck) {
          localStorage.removeItem(STORAGE_KEY);
          setForceDesktopState(false);
        }
      } catch { /* ignore */ }
    }

    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Keep the viewport meta in sync. On narrow devices, always apply the
  // mobile viewport (permissive zoom). Only widen when forcing desktop.
  useEffect(() => {
    if (!mounted) return;
    applyViewport(isNarrow && forceDesktop);
  }, [mounted, isNarrow, forceDesktop]);

  // Also apply immediately on mount in case the static viewport was
  // restrictive (e.g. maximum-scale=1 from a stale build).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const mql = window.matchMedia(NARROW_QUERY);
    if (mql.matches) {
      const forced = (() => {
        try { return localStorage.getItem(STORAGE_KEY) === "1"; }
        catch { return false; }
      })();
      applyViewport(forced);
    }
  }, []);

  const setForceDesktop = useCallback((value: boolean) => {
    setForceDesktopState(value);
    try {
      if (value) localStorage.setItem(STORAGE_KEY, "1");
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore storage access errors */
    }
  }, []);

  const toggleView = useCallback(() => {
    setForceDesktop(!forceDesktop);
  }, [forceDesktop, setForceDesktop]);

  const value = useMemo<ViewModeContextValue>(
    () => ({
      mounted,
      isNarrow,
      forceDesktop,
      isMobile: mounted && isNarrow && !forceDesktop,
      toggleView,
      setForceDesktop,
    }),
    [mounted, isNarrow, forceDesktop, toggleView, setForceDesktop],
  );

  return (
    <ViewModeContext.Provider value={value}>
      {children}
    </ViewModeContext.Provider>
  );
}

export function useViewMode(): ViewModeContextValue {
  const ctx = useContext(ViewModeContext);
  if (!ctx) {
    // Safe fallback so components never crash if used outside the provider.
    return {
      mounted: false,
      isNarrow: false,
      forceDesktop: false,
      isMobile: false,
      toggleView: () => {},
      setForceDesktop: () => {},
    };
  }
  return ctx;
}
