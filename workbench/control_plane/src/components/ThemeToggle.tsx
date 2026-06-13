"use client";

import { useTheme } from "next-themes";
import { Sun, Moon } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * ThemeToggle — light/dark mode switch (Sun/Moon icons).
 *
 * Uses next-themes.  Mounted-only render prevents hydration mismatch.
 * Add to sidebar footer and mobile overflow menu.
 */

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <button className="rounded-lg p-1.5 text-muted-foreground" aria-label="Toggle theme">
        <div className="w-4 h-4" />
      </button>
    );
  }

  const isDark = theme === "dark";

  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground tech-transition"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Light mode" : "Dark mode"}
    >
      {isDark ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}

/**
 * ThemeToggleMenuItem — same toggle but styled as a full-width menu item
 * (for use in dropdowns and drawer menus). Accepts an optional onClick callback
 * to close the parent menu/drawer after toggling.
 */
export function ThemeToggleMenuItem({ onClick }: { onClick?: () => void }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <div className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-muted-foreground">Theme</div>;
  }

  const isDark = theme === "dark";

  return (
    <button
      onClick={() => {
        setTheme(isDark ? "light" : "dark");
        onClick?.();
      }}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground tech-transition"
    >
      {isDark ? <Sun size={16} className="shrink-0" /> : <Moon size={16} className="shrink-0" />}
      {isDark ? "Light mode" : "Dark mode"}
    </button>
  );
}
