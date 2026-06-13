"use client";

/**
 * ComingSoon — placeholder for apps that haven't been built yet.
 *
 * Shows the app icon (large), title, subtitle, and a brief description
 * so the sidebar structure feels real even before the app is live.
 */

import Link from "next/link";

interface ComingSoonProps {
  icon: string;
  title: string;
  subtitle?: string;
  description?: string;
  /** When set, shows a "return to Chat" link. */
  returnTo?: string;
}

export default function ComingSoon({
  icon,
  title,
  subtitle,
  description,
  returnTo,
}: ComingSoonProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-full gap-4 text-center px-4">
      {/* Icon */}
      <div className="w-16 h-16 rounded-2xl bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center">
        <span className="text-2xl font-mono font-bold text-zinc-400">
          {icon}
        </span>
      </div>

      {/* Title */}
      <div>
        <h1 className="text-lg font-semibold text-zinc-100">{title}</h1>
        {subtitle && (
          <p className="text-sm text-zinc-500 mt-0.5">{subtitle}</p>
        )}
      </div>

      {/* Description */}
      {description && (
        <p className="max-w-md text-sm text-zinc-600 leading-relaxed">
          {description}
        </p>
      )}

      {/* Coming soon badge */}
      <span className="text-[11px] px-3 py-1 rounded-full border border-amber-700/40 bg-amber-900/20 text-amber-400 font-medium">
        Coming soon
      </span>

      {/* Return link */}
      {returnTo && (
        <Link
          href={returnTo}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors mt-4 underline underline-offset-4"
        >
          ← Back to Chat
        </Link>
      )}
    </div>
  );
}
