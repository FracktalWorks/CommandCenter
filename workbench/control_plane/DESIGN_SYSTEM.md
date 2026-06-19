# CommandCenter Control Plane — Design System

Unified UI/UX standards for all Control Plane pages. Every page, endpoint, and
agent-generated UI MUST follow these conventions.

---

## Color Tokens (HSL — Tailwind CSS v4)

Defined in `src/app/globals.css` as CSS custom properties. Always use the
semantic token name, never a raw hex value.

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

Use **lucide-react** exclusively. Import icons directly:

```tsx
import { Zap, Plus, RefreshCw, X, Loader2 } from "lucide-react";
```

Common icon sizes:
- Inline with text: `w-3.5 h-3.5` or `w-4 h-4`
- Standalone buttons: `w-4 h-4` or `w-5 h-5`
- Card/tile icons: `w-5 h-5`

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

| Class | Purpose |
|---|---|
| `tech-transition` | Smooth 200ms cubic-bezier transition on all properties |
| `tech-glass` | Frosted glass panel (backdrop-blur + semi-transparent bg) |
| `tech-glass-subtle` | Softer glass effect |
| `tech-glow` | Primary-color box-shadow glow |
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

5. **Support dark + light themes.** All color usage must work with both
   `:root` (dark) and `.light` class themes. Test with ThemeToggle.

6. **Mobile-responsive.** Use `sm:` breakpoint prefixes. Side panels slide
   up from the bottom on mobile (`sm:hidden` + fixed bottom sheet).
   Grid columns: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5`.
