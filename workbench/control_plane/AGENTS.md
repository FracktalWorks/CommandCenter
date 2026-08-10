<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# This UI is themed — read DESIGN_SYSTEM.md first

`DESIGN_SYSTEM.md` in this directory is the contract, not a style suggestion.
The short version, because these are the three mistakes that actually happen:

1. **Never write a colour.** `bg-primary`, `text-muted-foreground`,
   `var(--success)` — never `#0ea5e9`, `hsl(…)`, or `bg-[#1a1b1e]`. On a
   coloured fill use the `-foreground` partner, not `text-white`.
   **`bg-sky-500` counts.** Tailwind's own palette is a hardcoded colour with a
   friendly name; it survives a theme switch while everything around it moves.
   For a set of things with no meaning and no ranking — @contexts, tags, chart
   series — use the **categorical ramp** `bg-cat-3/10 text-cat-3`, eight themed
   slots every theme defines in both modes (DESIGN_SYSTEM §1). Pick the slot by
   hashing the item's name, never by array index, and never reorder the slots.
2. **Never `import … from "lucide-react"`.** Use `<Icon name="Plus" />` — the
   active theme decides which pack draws it.
3. **Never hand-roll a control.** `Button` / `Input` / `Badge` from
   `src/components/ui/`. Material makes every button a pill, Graphite uppercases
   every label; no class string can express that.

All three are enforced by `src/lib/theme/conformance.test.ts` (five rules:
literals, `lucide-react`, bracket classes, solid-button chrome, raw palette
classes), which carries a frozen baseline for existing debt: a file with no
budget must be clean, a baselined file may not get worse, and a baselined file
that got *better* fails until you lower its number — so the debt figures never
quietly become fiction. **If your change improves a baselined file, lowering
its number is part of your change**, not a follow-up.

Type scale: `text-sm` / `text-xs` / `text-[11px]` / `text-[10px]`. Do not invent
an off-grid size — `text-[12px]` is `text-xs` written the long way, and it also
opts out of the user's density preference, because `--ui-scale` reaches rem and
not px.

`npx vitest run src/lib/theme/` before you push.
