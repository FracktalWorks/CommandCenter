# CommandCenter Control Plane — Design System

**The whole document in one sentence: never write a colour, an icon import, or a
control's chrome by hand — every one of those is a theme decision, and the theme
is a setting somebody can change for the entire company in one click.**

This is the contract for every page in the Control Plane and every app built
inside CommandCenter. `src/lib/theme/conformance.test.ts` enforces the parts a
machine can check; the rest is here.

---

## 0. What "themed" actually means here

CommandCenter ships four themes — RapidTool, Fluent, Material, Graphite —
switchable at **Settings → Appearance**, org-wide. They differ by far more than
palette:

| | RapidTool | Fluent | Material | Graphite |
|---|---|---|---|---|
| Corner radius | `0.75rem` | `0.25rem` | `1rem` | `0.125rem` |
| Button radius | follows radius | follows radius | `9999px` — full pills | follows radius |
| Icon set | Lucide | Fluent UI | Material Symbols | Lucide |
| Button labels | sentence case | sentence case | sentence case | **UPPERCASE** |
| Hover | opacity shift | opacity shift | 8% state layer | opacity shift |
| Glass blur | 16px | 30px | **0 — flat** | 8px |
| Glow | on | off | off | off |

Two axes, deliberately independent:

* **style** — the theme identity, on `<html data-theme="…">`
* **mode** — light/dark, on the `.light` / `.dark` class (next-themes)

Every theme supplies both modes, so the axes never interfere. A component that
handles one but not the other is broken on half the matrix.

**The consequence for you:** a hardcoded value is not "a small inconsistency."
It is a pixel that permanently leaves the design system, and it will *render
fine* — so nobody catches it until the day the theme changes and that one card
looks like it belongs to a different product.

---

## 1. Colour — always a token

Tailwind v4 is wired to the theme's custom properties, so the semantic class
names *are* the theme.

| Token | Class | Use |
|---|---|---|
| `--background` / `--foreground` | `bg-background` `text-foreground` | page base, primary text |
| `--card` / `--card-foreground` | `bg-card` | panels, tiles |
| `--popover` | `bg-popover` | menus, tooltips |
| `--primary` / `--primary-foreground` | `bg-primary` `text-primary` | interactive: buttons, links, active state |
| `--secondary` | `bg-secondary` | quiet fills, hover surfaces |
| `--muted` / `--muted-foreground` | `bg-muted` `text-muted-foreground` | subtle fill / secondary text |
| `--accent` | `text-accent` | one highlight, used sparingly |
| `--success` `--warning` `--destructive` (+ `-foreground`) | `text-success` … | states |
| `--border` / `--input` / `--ring` | `border-border` `ring-ring` | hairlines, focus |

**Never:** `#0ea5e9`, `rgb(…)`, `hsl(…)`, `bg-[#1a1b1e]`, or `style={{ color:
"…" }}` with a literal.

**Text on a coloured fill takes the `-foreground` partner**, not white.
`text-white` on `bg-warning` is invisible on a theme with a pale warning colour —
which is not hypothetical, it was a real bug in the sandbox stylesheet.

**Tints and translucency are fine and stay themed:** `bg-primary/10`,
`border-primary/30`, `color-mix(in srgb, var(--success) 12%, var(--card))`. A
token at an opacity is still a token.

### The three exceptions, and why they are exceptions

A literal is right only when the value is **not a theme decision**:

1. **Illustration** — a sun in a weather glyph is yellow because suns are
   yellow. Recolouring it per theme produces broken art, not themed art.
   (`genUITemplates.tsx`'s `WEATHER_INK`, `observability/pixel.tsx`.)
2. **Someone else's palette** — Gmail's label colours must match Gmail's or the
   value does not round-trip to the real mailbox. Meta blue on a "Connect with
   Facebook" button is Meta's, not ours.
3. **Identity** — a per-person avatar hue derived from their email must be
   *stable*; deriving it from the theme defeats the thing it is for.

"It would be a lot of work to migrate" is not on this list — that is debt, and
it belongs in the conformance test's baseline where it stays visible.

---

## 2. Icons — `<Icon>`, never an import

```tsx
import Icon from "@/components/Icon";

<Icon name="Plus" size={16} className="text-primary" />
```

Lucide names are the shared **vocabulary**; the active theme picks the **pack**.
`"Plus"` renders Lucide's `Plus` on RapidTool, `fluent:add-20-regular` on
Fluent, `material-symbols:add-rounded` on Material. Call sites never know.

`import { Plus } from "lucide-react"` pins that one glyph to Lucide on every
theme — one Lucide icon in a row of Material Symbols, which reads as a bug. Only
`components/Icon.tsx` and `lib/icons.tsx` may import it, and the conformance
test enforces that with no budget and no exceptions.

Need a component reference rather than an element (a `tabs={[{icon}]}` prop)?
Use `themedIcon("Plus")` from `@/components/Icon` — memoised, so it is stable
across renders.

**A name with no mapping in the active pack falls back to Lucide** rather than
rendering nothing. If you add an icon, add its mapping in
`lib/theme/icon-registry.ts` too, or it will silently stay Lucide forever.

Sizes: `14`–`16` inline with text, `18`–`20` standalone. Pick one per context.

---

## 3. Controls — the primitives, not a class string

```tsx
import Button from "@/components/ui/Button";
import Input, { Textarea } from "@/components/ui/Input";
import Badge from "@/components/ui/Badge";

<Button variant="primary" icon="Save" loading={saving}>Save</Button>
<Button variant="secondary">Cancel</Button>
<Button variant="ghost" size="icon" aria-label="Close"><Icon name="X" size={14} /></Button>
```

`Button` — `variant`: `primary | secondary | ghost | destructive | text`;
`size`: `sm | md | lg | icon-xs | icon-sm | icon | none`; plus `icon`,
`loading`, `radius`, `layout`.

**Why this is a component and not a documented class string.** Colour can be a
class. A theme's *control personality* cannot: Material's 8% hover state layer,
Fluent's outline on solid fills, the theme's focus-ring width and label
tracking. None of that is expressible in a `className`, which is exactly why the
primitives exist. A raw `<button className="bg-primary …">` is themed for colour
and frozen for everything else.

Graphite uppercases every button label and Material makes every button a pill —
neither is something a call site opts into, and neither is reachable from a
class string. That is the concrete reason for the primitive.

Two props exist because Tailwind genuinely cannot express the alternative — read
their doc comments before working around them:

* `layout` **replaces** the default `inline-flex items-center justify-center`.
  It is a prop, not something `className` can override, because
  `justify-center` and `justify-start` have equal specificity: which one wins
  depends on stylesheet order, not on your class attribute. `layout=""` is
  meaningful — a bare `<button>` is `inline-block`, and forcing `inline-flex`
  moves its content.
* `radius="keep"` omits the theme's button radius so an explicit `rounded-*`
  survives. For controls that predate the primitive and want the theme's label
  treatment and focus ring *without* resized corners. Use `theme` for anything
  new.

`className` on a primitive is for **layout only** — never colour, radius or
weight. If you find yourself reaching for those, the variant you want is
missing; add it to the primitive.

**Not every `<button>` is a control.** A clickable card or list row is a button
element for accessibility, and those legitimately stay raw — the rule is about
things that *look* like controls.

---

## 4. Effects, shape and motion

Use the utilities; they read theme tokens, so a flat theme flattens them.

| Class | What it does |
|---|---|
| `tech-transition` | the theme's duration + easing on all properties |
| `tech-glass` / `tech-glass-subtle` | frosted panel — **opaque on flat themes**, by design |
| `tech-glow` | primary glow — **off** where `glowStrength: 0` |
| `pb-safe` / `pt-safe` | iOS safe-area padding |

Radius comes from `--radius` via `rounded-sm/md/lg`. Don't write `rounded-[14px]`.

Motion: `duration-[var(--motion-duration)]` / `ease-[var(--motion-easing)]`, or
just `tech-transition`. Respect `prefers-reduced-motion`.

---

## 5. Apps that run in the sandbox

Custom Apps, generative-UI cards and React artifacts run in an **opaque-origin
iframe**. They inherit nothing from us — not our stylesheet, not `data-theme`,
not one custom property — so they get a separate, deliberately stable
vocabulary: the **`--cc-*` contract**.

* Defined in `src/lib/theme/app-tokens.ts`. **Nothing else may write those
  variables.** The frame itself — CSP, token block, `.cc-*` component kit and
  the `postMessage` bridge — is `src/lib/theme/sandbox-frame.ts`, deliberately
  free of React so the e2e suite can drive the *real* frame rather than a copy
  of it.
* Documented for app authors in
  `apps/agents/agent-app-builder/instructions.md`, which the conformance test
  checks against the code in both directions — a token that exists but is
  undocumented is one no app will use; a documented token that does not exist is
  one an app *will* use and silently lose, because an unresolvable `var()`
  invalidates the whole declaration.
* Applied twice: in the frame's initial `<style>` (so the first paint is
  correct, no flash) and as a live `postMessage` patch on a theme change — a
  patch rather than a rebuild, because rebuilding `srcDoc` remounts the document
  and a running app would lose whatever the user had typed into it.
* Icons cross as pre-rendered SVG from the active pack, so a sandboxed app's
  glyphs match the shell's.

**Adding a `--cc-*` token:** add it to `appTokens()`, document it in the
app-builder instructions, and the test will confirm you did both.

One honest limit: **self-hosted webfonts do not cross the boundary.** The frame's
CSP is `font-src data:` and the `@font-face` rules live in a stylesheet it cannot
reach, so a sandboxed app gets the theme's *named and system* families (Segoe UI
on Fluent, Roboto on Material) and falls back where one is absent. Colour, shape,
spacing, motion and icons all cross intact.

---

## 6. Shared components

Check `src/components/` before writing a tab bar, filter pills or a page header.

* `Tabs` — `variant="segmented"` (2–5 short labels) or `"underline"` (icons or
  longer labels). Takes icon **names**, not components.
* `FilterPills` — rounded filter buttons with counts.
* Page header — every page uses the same shape:

```tsx
<div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-border shrink-0">
  <div>
    <h1 className="text-base sm:text-lg font-bold text-foreground">Title</h1>
    <p className="text-xs text-muted-foreground mt-0.5">Description or status</p>
  </div>
  {/* actions */}
</div>
```

Layout: header → tabs/filters → `flex-1 overflow-y-auto` content, optional
`w-[380px]` desktop side panel (bottom sheet on mobile).

Spacing: page padding `px-4 sm:px-6`, content `p-4`, grid gaps `gap-3`.
Grids: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5`.

---

## 7. Contrast

Themes are checked against WCAG 2.1 AA by `src/lib/theme/contrast.test.ts`. It
carries a `KNOWN_SHORTFALLS` ratchet for pre-existing pairs: they may improve,
never regress, and **fixing one requires deleting its entry**, so the list can
never quietly become fiction.

If you add or edit a theme, run that test. Never signal state with colour alone —
pair it with an icon or a label.

---

## 8. Checklist before you open a PR

1. `npx vitest run src/lib/theme/` — conformance, contrast and token contract.
2. No literal colour, no `lucide-react` import, no hand-rolled control chrome.
3. Switch theme **and** mode in Settings → Appearance and look at your surface.
   Fluent and Material are the useful pair: `0.25rem` corners and 30px glass
   against `1rem` corners, pill buttons and no glass at all. Anything you
   hardcoded shows up immediately. Graphite is the second check — it uppercases
   button labels, so a control that missed the primitive stays sentence case
   next to ones that did not.
