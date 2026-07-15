# Command Center — DESIGN.md

This is the single source of truth for how any UI, document, report, or HTML you
generate should look. Everything you render — a Markdown report, an HTML page, an
`emit_generative_ui` card, a full-page interactive report — must follow this
design language so it feels native to Command Center. When you write HTML/CSS,
use these exact tokens instead of inventing colors or spacing.

---

## 1. Visual theme & atmosphere

Command Center is a **dark-first, professional, technical control surface** —
think a calm mission-control console, not a marketing page. It is precise,
low-noise, and confident. Surfaces are deep blue-grey; content sits on subtly
elevated cards; a single blue accent carries interactivity and a warm orange
accent marks highlights and calls to action. Motion is subtle and purposeful,
never decorative. Prefer clarity and restraint over ornament.

Design mood words: **precise, calm, technical, trustworthy, spacious.**

---

## 2. Color palette & roles

Use these semantic roles, not raw hex. In-app, they exist as CSS variables
(`var(--primary)` etc.); in generated HTML sandboxes they are pre-defined as
`--cc-*` variables (see §9). The HSL values below are the dark theme (the base);
light-theme overrides are applied automatically by the app.

| Role | Token | Dark value | Use for |
|------|-------|-----------|---------|
| Background | `--background` | `hsl(220 13% 8%)` | Page / app base |
| Foreground | `--foreground` | `hsl(210 40% 98%)` | Primary text |
| Card | `--card` | `hsl(220 13% 10%)` | Elevated surface / panel |
| Popover | `--popover` | `hsl(220 13% 12%)` | Menus, tooltips |
| **Primary** | `--primary` | `hsl(198 89% 50%)` | Interactive blue: buttons, links, focus, active state |
| Secondary | `--secondary` | `hsl(220 13% 14%)` | Quiet buttons, chips, input fills |
| Muted | `--muted` | `hsl(220 13% 15%)` | Subtle fills |
| Muted text | `--muted-foreground` | `hsl(215 20% 65%)` | Secondary / helper text |
| **Accent** | `--accent` | `hsl(27 96% 61%)` | Warm orange highlight / attention (use sparingly) |
| Success | `--success` | `hsl(142 76% 47%)` | Positive state, done |
| Warning | `--warning` | `hsl(47 96% 53%)` | Caution |
| Destructive | `--destructive` | `hsl(0 63% 60%)` | Danger, delete |
| Border | `--border` | `hsl(220 13% 16%)` | Hairline separators, card outlines |
| Ring | `--ring` | `hsl(198 89% 50%)` | Focus outline (matches primary) |

**Rules:**
- Blue (`--primary`) is the ONLY interactive color. If it's clickable, it's blue.
- Orange (`--accent`) is a spotlight, not a second button color. Use it for one
  key metric, a highlight, or an "attention" badge — never for large fills.
- Never introduce colors outside this palette. No pure black (`#000`), no pure
  white text on dark (use `--foreground`), no random greens/purples.

---

## 3. Typography

- **Font family:** the app's system UI stack (Inter / system-ui, sans-serif).
  In generated HTML, use `font-family: var(--cc-font, system-ui, -apple-system, "Segoe UI", sans-serif)`.
- Monospace (code, data, keys): `ui-monospace, "SF Mono", Menlo, Consolas, monospace`.
- **Hierarchy:**
  - Page title / H1 — `1.5rem`, weight `600`, tight tracking.
  - Section / H2 — `1.125rem`, weight `600`.
  - Sub-section / H3 — `0.95rem`, weight `600`, often `--muted-foreground`.
  - Body — `0.875rem`, weight `400`, line-height `1.6`.
  - Caption / meta — `0.75rem`, `--muted-foreground`, often uppercase with
    `letter-spacing: 0.05em` for section labels.
- Numbers and metrics can be larger (`2rem`+, weight `600`) — data is the hero.
- Do not use more than two weights in one component. Keep it quiet.

---

## 4. Component styling

- **Buttons** (primary): background `--primary`, text `--primary-foreground`,
  `border-radius: calc(var(--radius) - 0.25rem)`, padding `0.5rem 1rem`, weight
  `500`, `hover: opacity 0.9`, `transition: 150ms`. Secondary buttons use
  `--secondary` fill with `--foreground` text.
- **Cards:** `--card` background, `1px solid --border`, `border-radius: var(--radius)`
  (`0.75rem`), padding `1rem–1.5rem`. Elevation via a soft shadow, not a heavy one.
- **Inputs / selects / textareas / sliders:** `--secondary` (or `--background`)
  fill, `1px solid --border`, `--radius` corners, focus ring `--ring`. Sliders
  use `--primary` for the thumb and filled track.
- **Badges / pills:** small, `--secondary` fill, `--muted-foreground` text, thin
  border; status badges tint toward success/warning/destructive.
- **Tables:** hairline `--border` row separators, `--muted-foreground` header row
  (uppercase caption style), comfortable cell padding (`0.5rem 0.75rem`), no heavy
  gridlines.
- Interactive elements always show a hover and a focus state.

---

## 5. Layout & spacing

- Spacing scale (multiples of `0.25rem`): `4, 8, 12, 16, 24, 32, 48px`. Stick to
  the scale; don't use arbitrary values.
- Generous whitespace. Group related content in cards; separate groups with space,
  not lines, where possible.
- Content max-width for readable documents: ~`720–860px`, centered.
- Use CSS grid / flexbox for structure. Dashboards: responsive grid of cards
  (`repeat(auto-fit, minmax(220px, 1fr))`).

---

## 6. Depth & elevation

- Elevation is subtle. Base page → cards → popovers, each one step lighter
  (`8% → 10% → 12%` lightness) plus a soft shadow.
- Shadows: soft and low-spread, e.g. `0 1px 3px rgba(0,0,0,0.3)` for cards,
  slightly larger for popovers. No harsh, high-contrast drop shadows.
- Borders do most of the separating work; shadows are a light accent.

---

## 7. Motion

- Default transition: `150ms` for hovers/small state, `200–250ms` for panels.
- Easing curve: `cubic-bezier(0.25, 0.46, 0.45, 0.94)` (exposed as `--cc-ease`).
- Animate opacity and transform (fade/slide/scale). Avoid animating layout
  properties. Keep entrances short and calm (a 200ms fade-up, not a bounce).
- Respect `prefers-reduced-motion` — gate non-essential animation behind it.

---

## 8. Do's and don'ts

**Do**
- Use the semantic tokens/variables for every color, radius, and spacing value.
- Let data be the hero: big numbers, clear labels, quiet chrome.
- Prefer a card + table + a single accent metric over a wall of text.
- Keep one primary action per view; make it blue.

**Don't**
- Don't hard-code hex colors, pure black/white, or off-palette hues.
- Don't use more than one orange accent per view.
- Don't add decorative gradients, glows, or drop shadows for their own sake.
- Don't cram — when in doubt, add spacing and remove borders.
- Don't invent a new visual style; match what's described here.

---

## 9. Generating documents & HTML (how this applies to your output)

**Markdown documents** (`write_artifact("outputs/report.md", ...)`): the app
renders them with the design system automatically (headings, tables, code blocks
are already themed). Just write clean, well-structured Markdown — clear headings,
tables for tabular data, short paragraphs. The live preview shows exactly how the
user sees it.

**HTML documents / full-page reports** (`write_artifact("outputs/report.html", ...)`
or an `emit_generative_ui` `html` node): these open in the side panel and render
in a sandbox. The following CSS variables are **pre-injected** — use them, don't
redefine colors:

```
--cc-primary  --cc-accent  --cc-fg  --cc-muted  --cc-card  --cc-secondary
--cc-border   --cc-success --cc-warning --cc-danger --cc-radius --cc-ease
```

- Wrap the document in a container with `max-width` and centered layout.
- Use `--cc-card` panels on the `--cc-*` background, `--cc-border` hairlines,
  `--cc-primary` for anything interactive, one `--cc-accent` highlight.
- Native `button/input/select/textarea` and range sliders are pre-styled on-brand
  — you usually don't need to style them.

**Report design kit (USE THESE for full-page HTML documents & reports).** A set of
pre-styled, on-brand building blocks is available — write terse semantic HTML with
these class names and you get a polished Command Center report with zero custom CSS.
Wrap the whole document in `<div class="cc-report">…</div>`. Blocks:

- `cc-eyebrow` — a mono uppercase kicker with a leading rule (section label).
- `cc-sec-num` — a small accent section number/tag placed before an `<h2>`.
- `cc-lede` — the large intro paragraph under the title.
- `cc-callout` (accent) / add `cc-callout-key` (blue) — a tinted highlight panel;
  put a `<span class="cc-tag">Note</span>` then a `<p>` inside.
- `cc-chips` with `cc-chip` children (use `<b>` for the value) — metadata row.
- `cc-grid` of `cc-card`s (each `<h4>` may lead with `<span class="cc-dot">`) —
  responsive card grid for parallel points.
- `cc-compare` wrapping a `<table>` — comparison table; mark cells with
  `cc-yes` / `cc-no` / `cc-partial`, or a `cc-pill` for status.
- `cc-diagram` wrapping a `<pre>` — ASCII architecture/flow diagram; use `<b>` for
  key nodes and `<span class="cc-hl">` for accent notes.
- `cc-steps` of `cc-step` (each has a `<div class="cc-n">1</div>` + `<h4>`/`<p>`) —
  numbered sequence (ONLY when order truly matters).
- `cc-phase` rows (each has `<span class="cc-badge">Phase 1</span>` + content) —
  a phased plan / roadmap.

Compose these instead of hand-rolling report CSS; they already match this
document's palette, spacing, typography, and both light/dark themes. Reach for a
`cc-report` HTML document (opened in the side panel) whenever you produce something
substantial — an analysis, a plan, a comparison, a briefing — rather than a long
plain-text chat reply.
- **Interactivity** (this is encouraged — build reports the user can act on):
  - `data-cc-action='<message>'` on a clickable element (or `ccAction('...')`)
    fires a fixed follow-up message back to the agent, like a button press.
  - `data-cc-submit='<label>'` on a button harvests every named
    input/select/textarea in its enclosing `form`/`[data-cc-form]` and sends
    their VALUES back; or call `ccSubmit('Label', value)` directly. Use this so a
    slider/dropdown/number the user sets actually reaches you.
  - No external network or CDNs — inline all CSS/JS; embed images as data URIs.
- Respect `prefers-color-scheme` / the injected theme; don't force a light page
  onto the dark app.

The guiding test for anything you generate: **would it look at home dropped into
the Command Center app?** If yes, ship it. If it looks like a generic Bootstrap
page, rework it against this document.
