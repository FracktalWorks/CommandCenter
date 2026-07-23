"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

/**
 * Shared, inbox-zero-styled primitives for the Assistant tabs (Test / History /
 * Settings). Kept dependency-free (React + lucide + theme tokens) to match the
 * rest of the email app, which hand-rolls its overlays.
 */

// ── Modal ────────────────────────────────────────────────────────────────────

export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  maxWidth = "max-w-lg",
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-4 sm:pt-20 px-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      {/* Height cap in dvh (not vh): on mobile, 100vh includes the browser
          chrome, so an 85vh card could run past the visible viewport and hide
          its footer buttons behind the bottom bar. dvh tracks what's actually
          visible; the footer stays pinned on-screen. */}
      <div
        className={`relative w-full ${maxWidth} bg-card border border-border rounded-xl shadow-2xl overflow-hidden max-h-[calc(100dvh-6.5rem)] sm:max-h-[min(85vh,calc(100dvh-7rem))] flex flex-col`}
      >
        <div className="flex items-start justify-between px-4 py-3 border-b border-border bg-secondary/50">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{title}</div>
            {description && (
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {description}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors flex-shrink-0"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-4 space-y-3 overflow-y-auto">{children}</div>
        {footer && (
          <div className="flex items-center gap-2 px-4 py-3 border-t border-border bg-secondary/30">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Toggle ───────────────────────────────────────────────────────────────────

export function Toggle({
  enabled,
  onChange,
  disabled = false,
  title,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className={`relative flex-shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        enabled ? "bg-primary" : "bg-secondary"
      }`}
      style={{ height: 18, width: 32 }}
    >
      <span
        className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all ${
          enabled ? "left-[15px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

/** A Test ↔ Apply style switch with a label on each side. */
export function LabeledToggle({
  label,
  labelRight,
  enabled,
  onChange,
}: {
  label: string;
  labelRight: string;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={enabled ? "text-muted-foreground" : "text-foreground font-medium"}>
        {label}
      </span>
      <Toggle enabled={enabled} onChange={onChange} />
      <span className={enabled ? "text-foreground font-medium" : "text-muted-foreground"}>
        {labelRight}
      </span>
    </div>
  );
}

// ── HoverPopover ─────────────────────────────────────────────────────────────

/**
 * Reveals `content` on hover (desktop) or tap (touch). Tracks open state so a tap
 * toggles it and an outside click closes it.
 */
export function HoverPopover({
  trigger,
  children,
  align = "right",
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div
      ref={ref}
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="inline-flex"
      >
        {trigger}
      </button>
      {open && (
        <div
          className={`absolute top-full mt-1.5 z-50 ${
            align === "right" ? "right-0" : "left-0"
          } w-72 max-w-[min(22rem,80vw)] bg-card border border-border rounded-lg shadow-xl p-3 text-left cursor-default`}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// ── SettingCard ──────────────────────────────────────────────────────────────

export function SettingCard({
  title,
  description,
  right,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-xl px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {description && (
            <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
              {description}
            </p>
          )}
        </div>
        {right && <div className="flex-shrink-0">{right}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

export function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium px-1 pt-1">
      {children}
    </h2>
  );
}
