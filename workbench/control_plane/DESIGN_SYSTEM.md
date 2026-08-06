# CommandCenter Control Plane — Design System

Unified UI/UX standards for all Control Plane pages. Every page, endpoint, and
agent-generated UI MUST follow these conventions.

---

## The design system is themeable

The Control Plane ships several themes — RapidTool (default), Fluent
(Microsoft), Material (Google) and Graphite — and members switch between them
in **Settings → Appearance**. A theme changes colours, fonts, corner radius,
effects **and the icon pack**, all at once, across every page.

This works only because components describe intent (`bg-primary`,
`rounded-lg`, `<Icon name="Plus">`) rather than appearance (`bg-[#0ea5e9]`,
`rounded-[12px]`, `<Plus />`). Hardcoding any visual value opts that element
out of theming: it will look correct on the default theme and wrong on every
other one.

**The three rules that keep the app themeable:**

1. **Never hardcode a colour.** Use the semantic tokens below.
2. **Never hardcode a radius, blur, shadow or transition.** Use `rounded-*`,
   `tech-glass`, `tech-elevated`, `tech-transition`.
3. **Never import from `lucide-react` in a component.** Use
   `<Icon name="Plus" />` from `@/components/Icon`.

Themes are data: `src/lib/theme/themes.ts`. Adding one is a manifest entry —
no component, CSS or Tailwind change. See "Theming engine" at the end of this
document.

---

## Color Tokens (HSL — Tailwind CSS v4)

Every theme supplies a full set of these; the table shows the default theme's
values. Always use the semantic token name, never a raw hex value.

| Token | Dark (default) | Light (.light) | Usage |
|---|---|---|---|
| `--primary` | `hsl(198 89% 50%)` | `hsl(198 89% 35%)` | Primary actions, active states, links |
| `--accent` | `hsl(27 96% 61%)` | `hsl(27 96% 61%)` | Call-to-action highlights |
| `--background` | `hsl(220 13% 8%)` | `hsl(0 0% 100%)` | Page background |
| `--foreground` | `hsl(210 40% 98%)` | `hsl(222.2 84% 4.9%)` | Primary text |
| `--card` | `hsl(220 13% 10%)` | `hsl(0 0% 100%)` | Card / panel surfaces |
| `--secondary` | `hsl(220 13% 14%)` | `hsl(210 40% 96%)` | Secondary surfaces, hover states |
| `--muted` | `hsl(220 13% 15%)` | `hsl(210 40% 96%)` | Muted backgrounds |
| `--muted-foreground` | `hsl(215 20% 65%)` | `hsl(215.4 16.3% 46.9%)` | Secondary text, placeholders |
| `--border` | `hsl(220 13% 16%)` | `hsl(214.3 31.8% 91.4%)` | Borders, dividers |
| `--success` | `hsl(142 76% 47%)` | `hsl(142 76% 47%)` | Success states, connected indicators |
| `--warning` | `hsl(47 96% 53%)` | `hsl(47 96% 53%)` | Warning states |
| `--destructive` | `hsl(0 63% 60%)` | `hsl(0 84.2% 60.2%)` | Error states, delete actions |
| `--ring` | `hsl(198 89% 50%)` | `hsl(198 89% 50%)` | Focus rings |

**Tailwind classes:** `bg-primary`, `text-foreground`, `border-border`, etc.
Never use `bg-[#1a1b1e]` or arbitrary hex values.

---

## Typography

| Element | Font | Class |
|---|---|---|
| Body text | Geist Sans | `font-sans` (default) |
| Code / monospace | Geist Mono | `font-mono` |
| Page title (`h1`) | Geist Sans | `text-base sm:text-lg font-bold text-foreground` |
| Section heading | Geist Sans | `text-sm font-semibold text-foreground` |
| Body / description | Geist Sans | `text-xs text-muted-foreground` |
| Small label / badge | Geist Sans | `text-[10px] text-muted-foreground` |

---

## Shared Components

**Always import from `@/components/` — never inline ad-hoc versions.**

### Tabs (`@/components/Tabs`)

Two variants for tab navigation:

- **`variant="segmented"`** — Pill-group style. Best for 2–5 short text labels.
  Used in: Settings > Models.
- **`variant="underline"`** — Bottom-border highlight style. Best for tabs
  with icons or longer labels. Used in: Integrations.

```tsx
import Tabs from "@/components/Tabs";
import { Zap, Mail, Server, Puzzle } from "lucide-react";

<Tabs
  tabs={[
    { id: "apis",    label: "APIs",    icon: Zap },
    { id: "email",   label: "Email",   icon: Mail },
    { id: "mcps",    label: "MCPs",    icon: Server },
    { id: "plugins", label: "Plugins", icon: Puzzle },
  ]}
  activeTab={tab}
  onTabChange={setTab}
  variant="underline"
/>
```

### FilterPills (`@/components/FilterPills`)

Rounded pill buttons for filtering lists. Used in: Agents, Models.

```tsx
import FilterPills from "@/components/FilterPills";

<FilterPills
  items={[
    { id: "all",     label: "All",     count: 12 },
    { id: "builtin", label: "Built-in", count: 5 },
    { id: "custom",  label: "Custom",   count: 7 },
  ]}
  activeId={filter}
  onChange={setFilter}
/>
```

### Buttons

| Role | Classes |
|---|---|
| Primary action | `rounded-lg bg-primary px-3 sm:px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 tech-transition` |
| Secondary / cancel | `rounded-lg border border-border px-3 sm:px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-primary/30 tech-transition` |
| Ghost / icon-only | `p-2 rounded-lg border border-border text-muted-foreground hover:bg-secondary tech-transition` |
| Destructive | `rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive hover:bg-destructive/20 tech-transition` |

### Page Header

Every page MUST use the same header pattern:

```tsx
<div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-border shrink-0">
  <div>
    <h1 className="text-base sm:text-lg font-bold text-foreground">Page Title</h1>
    <p className="text-xs text-muted-foreground mt-0.5">Brief description or status</p>
  </div>
  {/* Action buttons go here */}
</div>
```

### Status Indicators

- **Connected/Ready:** `text-success` with a `bg-success` dot (`w-1.5 h-1.5 rounded-full`)
- **Disconnected/Blocked:** `text-muted-foreground` with a `bg-muted` dot
- **Warning:** `text-warning` with `bg-warning` dot

### Cards / Tiles

Interactive cards (agent tiles, provider cards, API cards) use:

```tsx
<button className={`text-left w-full p-3 sm:p-4 rounded-xl border tech-transition
  ${selected ? "border-primary bg-primary/5 ring-1 ring-primary/20"
             : "border-border bg-card hover:border-primary/40 hover:bg-secondary/30"}`}>
  {/* card content */}
</button>
```

---

## Icons

Use the **`<Icon>`** component. It renders the glyph from whichever pack the
active theme asks for — Lucide, Fluent System Icons, or Material Symbols.

```tsx
import Icon from "@/components/Icon";

<Icon name="Plus" size={16} />
<Icon name="AlertTriangle" size={14} className="text-warning" />
```

**Lucide names are the vocabulary.** `name` is always a Lucide component name
(`Plus`, `Trash2`, `MessageCircle`); other packs map onto those names. Any of
Lucide's ~1,600 names works — one without a mapping simply renders the Lucide
glyph on every theme, which is a safe default, not an error.

Migrating an existing call site is a one-line change:

```diff
- import { Plus } from "lucide-react";
+ import Icon from "@/components/Icon";
- <Plus size={16} />
+ <Icon name="Plus" size={16} />
```

**Do not import from `lucide-react` in a component.** A direct import pins that
glyph to Lucide, so it stays Lucide-shaped while everything around it turns
Fluent or Material.

Two deliberate exceptions, both because they cannot run React hooks:
`resolveIcon()` in `@/lib/icons` (used by server components) and
`iconSvg.ts` (renders to a static SVG string for the HTML sandbox).

Common icon sizes:
- Inline with text: `size={14}` or `size={16}`
- Standalone buttons: `size={16}` or `size={18}`
- Card/tile icons: `size={20}`

To add a mapping for a new icon, add it to `MAP` in
`scripts/build-icon-packs.mjs` and run `npm run build:icons`. The script
resolves candidates against the real collections, so a name that does not
exist fails loudly rather than shipping a blank square.

---

## Page Layout

Every page follows this structure:

```
┌──────────────────────────────────────────────┐
│ Page Header (h1 + description + actions)     │ ← border-b
├──────────────────────────────────────────────┤
│ Tabs or FilterPills (if needed)              │ ← border-b
├──────────────────────────────────────────────┤
│ Main content area (flex-1 overflow-y-auto)   │
│   - Filters / search bar                     │
│   - Grid or list of items                    │
│   - Optional side panel (desktop, w-[380px]) │
└──────────────────────────────────────────────┘
```

---

## Tech Utilities (from globals.css)

All of these are token-driven, so their behaviour changes with the theme — a
flat theme like Material renders `tech-glass` opaque and `tech-glow` invisible
rather than needing a separate code path.

| Class | Purpose |
|---|---|
| `tech-transition` | Themed transition on all properties (`--motion-duration` / `--motion-easing`) |
| `tech-glass` | Frosted panel — blur and opacity from `--glass-blur` / `--glass-opacity` |
| `tech-glass-subtle` | Same material at higher opacity, for modals and drawers over live content |
| `tech-glow` | Primary-colour glow, scaled by `--glow-strength` (0 disables it) |
| `tech-elevated` | Elevation shadow from `--elevation` — how flat themes express depth |
| `pb-safe` / `pt-safe` | iOS safe-area padding |

---

## Rules for Agents & Contributors

1. **Use shared components.** Check `src/components/` before writing any
   tab bar, filter pills, or page header. Import `Tabs`, `FilterPills`,
   or existing components.

2. **Follow the color tokens.** Never use arbitrary hex values or Tailwind
   arbitrary values like `bg-[#1a1b1e]`. Use `bg-primary`, `text-foreground`,
   `border-border`, etc.

3. **Match the page layout.** Every new page should mirror the header →
   tabs/filters → content pattern described above.

4. **Use consistent spacing.** Page-level padding is `px-4 sm:px-6`.
   Content padding is `p-4`. Gaps between grid items are `gap-3`.

5. **Support every theme, in both modes.** Colour usage must work in dark and
   light, and must not assume the default theme's shape or effects. Check a
   new surface against Fluent (square corners, no glow) and Material (round
   corners, flat) as well as the default — those two catch nearly every
   hardcoded value.

6. **Mobile-responsive.** Use `sm:` breakpoint prefixes. Side panels slide
   up from the bottom on mobile (`sm:hidden` + fixed bottom sheet).
   Grid columns: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5`.

7. **Use `<Icon>`, never a direct `lucide-react` import.** See Icons above.

---

## Theming engine

Where things live:

| File | Role |
|---|---|
| `src/lib/theme/themes.ts` | The themes themselves. **Add a theme here and nowhere else.** |
| `src/lib/theme/types.ts` | Token vocabulary — what a theme is allowed to set |
| `src/lib/theme/css.ts` | Manifests → `html[data-theme="…"]` CSS scopes |
| `src/lib/theme/store.ts` | Active theme, density, accent; org default vs member override |
| `src/lib/theme/surfaces.ts` | Monaco / Shiki theme resolution for the active theme |
| `src/lib/theme/boot.ts` | Pre-paint script that applies the stored theme (no flash) |
| `src/components/Icon.tsx` | The themed icon primitive |
| `scripts/build-icon-packs.mjs` | Regenerates the pruned icon packs (`npm run build:icons`) |
| `src/app/settings/appearance/` | The Settings UI |

**Two independent axes.** *Style* (which theme) lives on
`<html data-theme="…">`; *mode* (dark/light) stays on the `.light` / `.dark`
class managed by next-themes. Every theme defines both modes, so the axes never
interact. Structural tokens — radius, fonts, effects — are emitted once on the
theme's base scope and inherited by its light scope.

**Why `globals.css` still contains the default theme's values.** Those
`:root` / `.light` blocks are the no-JavaScript fallback. The generated scopes
outrank them on specificity (0,1,1 vs 0,1,0), so they never apply in a normal
session. They must stay identical to the `rapidtool` manifest —
`src/lib/theme/themes.test.ts` parses the stylesheet and fails if they drift.
**Change how the app looks by editing the manifest, not `globals.css`.**

**Third-party surfaces.** Monaco and Shiki ship closed sets of named themes and
cannot be driven by our CSS tokens, so each theme names its equivalents in
`surfaces`. Read them with `useMonacoTheme()` / `useShikiTheme()` — never branch
on `resolvedTheme === "light"`, which sees two states where the app has eight.
A unit test checks the names against Monaco's built-ins and the Shiki bundle,
because a typo there is invisible until someone opens a code view.

xyflow's `colorMode` legitimately stays dark/light: it only drives the
library's own chrome, and our nodes are styled with our tokens already.

**Preference resolution:** member override → organisation default → built-in
default. Members' choices are per-browser (localStorage); the org default is
stored in Postgres (`org_settings`, migration 145) and served by the gateway at
`GET/PUT /settings/appearance`, then cached locally so it survives the first
paint. Writing it needs `admin:settings:manage` — it changes everyone's UI.
An admin can lock the org to one theme by turning off personal overrides.

The gateway deliberately does **not** know which themes exist. `themeId` is
stored as an opaque, selector-safe string, because validating it against a copy
of `THEMES` would mean a backend deploy for every new theme. The frontend
re-validates on read and falls back for an id it cannot render.

**Contrast is gated.** `contrast.test.ts` measures every theme × mode × text
pair against WCAG AA and fails the build below it. Seven pairs in the original
RapidTool palette predate the gate and are recorded in `KNOWN_SHORTFALLS` as a
ratchet — they may improve, never regress, and fixing one forces its entry to
be deleted. **New themes get no such latitude: they must meet AA outright.**

Coverage: `src/lib/theme/*.test.ts` (manifests, CSS generation, icon registry,
contrast) and `e2e/theming.spec.ts` (computed styles and real glyph swapping in
a browser — the only place cascade order can actually be verified).
