"use client";

/**
 * Avatar Studio — customize each agent's office character.
 *
 * Pick an agent, tune its look (skin / hair / outfit / accessory / desk props /
 * room) with a LIVE scene preview, or generate a bespoke pixel-art sprite with
 * Pixel Lab. Saved overrides persist to the gateway (`agent_avatars`) and merge
 * into `/roster`, so the office shows the pinned look for everyone.
 *
 * The look editor drives `deriveAvatar(name, override)` (the same seam the office
 * uses); the sprite path pins a real PNG that wins over the procedural character.
 */

import React, { useMemo, useState } from "react";
import {
  Check,
  Loader2,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";

import {
  ACCESSORIES,
  AgentScene,
  type AvatarConfig,
  deriveAvatar,
  DESK_PROPS,
  HAIR,
  HAIR_STYLES,
  OUTFIT_COLORS,
  OUTFIT_TYPES,
  roleFor,
  ROOMS,
  type SceneState,
  SKIN,
  WALL_PROPS,
} from "./scene";

interface AvatarOverride {
  config?: Partial<AvatarConfig>;
  sprite?: string | null;
}
export interface StudioAgent {
  name: string;
  description?: string;
  avatar?: AvatarOverride | null;
}

// A default generation prompt per role so "Generate" needs zero typing.
const ROLE_PROMPT: Record<string, string> = {
  coder: "a developer wearing a blue hoodie and a headset",
  sales: "a salesperson wearing a dark navy business suit and a headset",
  planner: "a planner wearing a warm red sweater and round glasses",
  triage: "a friendly support agent wearing a green hoodie",
  reconciler: "an accountant wearing a grey sweater and glasses",
  orchestrator: "a team leader wearing a purple suit and a headset",
  default: "an office worker wearing a grey sweater",
};

function labelize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, " ");
}

// ── Small control primitives ────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function Swatch({
  color,
  active,
  onClick,
}: {
  color: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`h-6 w-6 rounded-md border transition-transform ${
        active ? "ring-2 ring-primary ring-offset-1 ring-offset-background scale-105" : "border-border hover:scale-105"
      }`}
      style={{ background: color }}
      aria-label={color}
    />
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1 text-xs capitalize transition-colors ${
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-card/60 text-muted-foreground hover:border-primary/40 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

// ── Studio ───────────────────────────────────────────────────────────────────

export function AvatarStudio({
  agents,
  onSaved,
}: {
  agents: StudioAgent[];
  onSaved?: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(agents[0]?.name ?? null);

  // Resolve a valid target without an effect: fall back to the first agent when
  // the selection is empty or no longer in the roster (it loads asynchronously).
  const active = useMemo(
    () => agents.find((a) => a.name === selected) ?? agents[0] ?? null,
    [agents, selected],
  );

  if (!active) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No agents to customize yet.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 lg:flex-row">
      {/* Agent picker */}
      <div className="shrink-0 lg:w-52">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Agents
        </div>
        <div className="flex gap-2 overflow-x-auto lg:max-h-full lg:flex-col lg:overflow-y-auto">
          {agents.map((a) => (
            <button
              key={a.name}
              onClick={() => setSelected(a.name)}
              className={`flex shrink-0 items-center gap-2 rounded-xl border p-1.5 text-left transition-colors lg:w-full ${
                a.name === active.name
                  ? "border-primary bg-primary/5"
                  : "border-border bg-card/50 hover:border-primary/40"
              }`}
            >
              <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg">
                <AgentScene name={a.name} state="idle" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-foreground">{a.name}</div>
                {a.avatar?.sprite ? (
                  <div className="flex items-center gap-1 text-[10px] text-primary">
                    <Sparkles size={9} /> custom
                  </div>
                ) : a.avatar?.config && Object.keys(a.avatar.config).length > 0 ? (
                  <div className="text-[10px] text-muted-foreground">styled</div>
                ) : (
                  <div className="text-[10px] text-muted-foreground/60">default</div>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Keyed so each agent gets a fresh editor seeded from its stored override —
          no set-state-in-effect syncing needed. */}
      <AvatarEditor key={active.name} agent={active} onSaved={onSaved} />
    </div>
  );
}

// ── Per-agent editor (preview + look controls + Pixel Lab generation) ────────

function AvatarEditor({
  agent,
  onSaved,
}: {
  agent: StudioAgent;
  onSaved?: () => void;
}) {
  const name = agent.name;
  const stored = agent.avatar ?? null;
  // Seed once from props via useState initializers (component is keyed by name).
  const [draft, setDraft] = useState<AvatarConfig>(() =>
    deriveAvatar(name, (stored?.config ?? undefined) as Partial<AvatarConfig>),
  );
  const [sprite, setSprite] = useState<string | null>(stored?.sprite ?? null);
  // Did the operator style a procedural look? Seeded true if a non-empty config
  // override was already saved. Drives whether the office/preview show the styled
  // character vs the default role sprite (a role sprite always exists).
  const storedHasConfig = Boolean(stored?.config && Object.keys(stored.config).length > 0);
  const [touched, setTouched] = useState(storedHasConfig);
  const [prompt, setPrompt] = useState(() => ROLE_PROMPT[roleFor(name)] ?? ROLE_PROMPT.default);
  const [previewState, setPreviewState] = useState<SceneState>("working");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const selected = name;
  const current = agent;

  const set = (patch: Partial<AvatarConfig>) => {
    setTouched(true);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const toggleProp = (p: string) =>
    set({
      deskProps: draft.deskProps.includes(p)
        ? draft.deskProps.filter((x) => x !== p)
        : [...draft.deskProps, p],
    });

  // What the preview shows (mirrors the office precedence): a pinned custom
  // sprite wins; else if the operator has styled a look, show the procedural
  // character so edits are visible; else the default role sprite.
  const previewSprite: string | null | undefined = sprite ? sprite : touched ? null : undefined;
  const usingSprite = Boolean(sprite);

  const generate = async () => {
    setGenerating(true);
    setMsg(null);
    try {
      const res = await fetch("/api/observability/avatars/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: prompt }),
      });
      const data = await res.json();
      if (res.ok && data.sprite) {
        setSprite(data.sprite);
        setMsg({ kind: "ok", text: "Sprite generated — Save to pin it." });
      } else {
        setMsg({ kind: "err", text: data.detail || data.error || "Generation failed." });
      }
    } catch {
      setMsg({ kind: "err", text: "Generation request failed." });
    } finally {
      setGenerating(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    // Persist the styled look ONLY if the operator actually edited it — otherwise
    // send an empty config so the office keeps the default role sprite (an empty
    // override must not silently downgrade a real sprite to procedural). The
    // pinned sprite lives in its own column, so strip it from the config payload.
    const config: Partial<AvatarConfig> = touched ? { ...draft } : {};
    delete (config as AvatarConfig).sprite;
    try {
      const res = await fetch(`/api/observability/avatars/${encodeURIComponent(selected)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, sprite }),
      });
      if (res.ok) {
        setMsg({ kind: "ok", text: "Saved — the office will update shortly." });
        onSaved?.();
      } else {
        const d = await res.json().catch(() => ({}));
        setMsg({ kind: "err", text: d.detail || d.error || "Save failed." });
      }
    } catch {
      setMsg({ kind: "err", text: "Save request failed." });
    } finally {
      setSaving(false);
    }
  };

  const resetToDefault = async () => {
    setResetting(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/observability/avatars/${encodeURIComponent(selected)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setDraft(deriveAvatar(selected));
        setSprite(null);
        setTouched(false);
        setMsg({ kind: "ok", text: "Reverted to the default look." });
        onSaved?.();
      } else {
        setMsg({ kind: "err", text: "Reset failed." });
      }
    } catch {
      setMsg({ kind: "err", text: "Reset request failed." });
    } finally {
      setResetting(false);
    }
  };

  const roomKeyOf = (c: AvatarConfig) =>
    Object.keys(ROOMS).find((k) => ROOMS[k].wall === c.room.wall) ?? "neutral";

  return (
    <>
      {/* Live preview */}
      <div className="flex shrink-0 flex-col gap-3 lg:w-72">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Preview
        </div>
        <div className="overflow-hidden rounded-2xl border border-border bg-background/40">
          <AgentScene name={selected} state={previewState} config={draft} sprite={previewSprite} />
        </div>
        <div className="flex items-center justify-center gap-1">
          {(["working", "idle", "error"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setPreviewState(s)}
              className={`rounded-lg px-2.5 py-1 text-xs capitalize transition-colors ${
                previewState === s
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/50"
              }`}
            >
              {s === "idle" ? "sleeping" : s}
            </button>
          ))}
        </div>
        <p className="text-center text-[11px] text-muted-foreground/70">
          {usingSprite
            ? "Showing a pinned Pixel Lab sprite. Clear it to fall back to the styled character."
            : touched
              ? "Styled character (procedural). Generate a sprite for higher-fidelity art."
              : "Default role sprite. Edit the look for a styled character, or generate a custom one."}
        </p>
      </div>

      {/* Controls */}
      <div className="min-w-0 flex-1 overflow-y-auto rounded-2xl border border-border bg-card/40 p-4">
        <div className="mb-4 flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-foreground">{selected}</div>
            {current?.description && (
              <div className="text-xs text-muted-foreground">{current.description}</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={resetToDefault}
              disabled={resetting}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-50"
            >
              {resetting ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
              Reset
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Save
            </button>
          </div>
        </div>

        {msg && (
          <div
            className={`mb-4 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
              msg.kind === "ok"
                ? "border-success/20 bg-success/5 text-success"
                : "border-destructive/20 bg-destructive/5 text-destructive"
            }`}
          >
            {msg.kind === "ok" ? <Check size={13} /> : <Sparkles size={13} />}
            {msg.text}
          </div>
        )}

        {/* Pixel Lab generation */}
        <div className="mb-5 rounded-xl border border-primary/20 bg-primary/[0.03] p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Wand2 size={14} className="text-primary" /> Generate a sprite with Pixel Lab
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={2}
            className="w-full resize-none rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none"
            placeholder="Describe the character…"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={generate}
              disabled={generating || !prompt.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-primary/90 px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {generating ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
              {generating ? "Generating…" : "Generate"}
            </button>
            {sprite && (
              <button
                onClick={() => setSprite(null)}
                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
              >
                <Trash2 size={13} /> Clear sprite
              </button>
            )}
            <span className="text-[10px] text-muted-foreground/60">
              transparent · waist-up · ~10-40s
            </span>
          </div>
        </div>

        {/* Look editor */}
        <div className="flex flex-col gap-4">
          <Row label="Skin">
            {SKIN.map((c) => (
              <Swatch key={c} color={c} active={draft.skin === c} onClick={() => set({ skin: c })} />
            ))}
          </Row>

          <Row label="Hair style">
            {HAIR_STYLES.map((s) => (
              <Chip
                key={s}
                active={draft.hair.style === s}
                onClick={() => set({ hair: { ...draft.hair, style: s } })}
              >
                {s}
              </Chip>
            ))}
          </Row>
          <Row label="Hair colour">
            {HAIR.map((c) => (
              <Swatch
                key={c}
                color={c}
                active={draft.hair.color === c}
                onClick={() => set({ hair: { ...draft.hair, color: c } })}
              />
            ))}
          </Row>

          <Row label="Outfit">
            {OUTFIT_TYPES.map((t) => (
              <Chip
                key={t}
                active={draft.outfit.type === t}
                onClick={() => set({ outfit: { ...draft.outfit, type: t } })}
              >
                {t}
              </Chip>
            ))}
          </Row>
          <Row label="Outfit colour">
            {OUTFIT_COLORS.map((c) => (
              <Swatch
                key={c}
                color={c}
                active={draft.outfit.color === c}
                onClick={() => set({ outfit: { ...draft.outfit, color: c, color2: c } })}
              />
            ))}
          </Row>

          <Row label="Accessory">
            {ACCESSORIES.map((a) => (
              <Chip
                key={String(a)}
                active={draft.accessory === a}
                onClick={() => set({ accessory: a })}
              >
                {a ?? "none"}
              </Chip>
            ))}
          </Row>

          <Row label="Room">
            {Object.keys(ROOMS).map((k) => (
              <Chip key={k} active={roomKeyOf(draft) === k} onClick={() => set({ room: ROOMS[k] })}>
                {k}
              </Chip>
            ))}
          </Row>
          <Row label="Wall">
            {WALL_PROPS.map((w) => (
              <Chip key={w} active={draft.wallProp === w} onClick={() => set({ wallProp: w })}>
                {w}
              </Chip>
            ))}
          </Row>

          <Row label="Desk props">
            {DESK_PROPS.map((p) => (
              <Chip key={p} active={draft.deskProps.includes(p)} onClick={() => toggleProp(p)}>
                {labelize(p)}
              </Chip>
            ))}
          </Row>
        </div>
      </div>
    </>
  );
}
