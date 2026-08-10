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
   **`bg-sky-500` counts** — Tailwind's own palette is a hardcoded colour with a
   friendly name. See rule 7 for what to use instead.
2. **Never `import … from "lucide-react"`.** Use `<Icon name="Plus" />` — the
   active theme decides which pack draws it.
3. **Never hand-roll a control.** `Button` / `Input` / `Select` / `Textarea` /
   `Badge` from `src/components/ui/`. Material makes every button a pill,
   Graphite uppercases every label; no class string can express that.
   **`Select` exists since S5** — a bare `<select>` wears the OS's own
   disclosure triangle, and 38 files had each copied their own class string
   instead. A **file input must be hidden** (`className="hidden"`) behind a
   `<Button>` that raises it, with the chosen filenames listed by the app:
   "Choose Files / No file chosen" is the browser's string in the browser's
   font and no theme can reach it.

All three are enforced by `src/lib/theme/conformance.test.ts` (**seven** rules:
literals, `lucide-react`, bracket classes, solid-button chrome, raw palette
classes, the `bg-accent text-accent-foreground` active pair rule 6 below forbids
— since S4 — and, since S5, raw `<select>`s and visible file inputs), which
carries a frozen baseline for existing debt: a file with no
budget must be clean, a baselined file may not get worse, and a baselined file
that got *better* fails until you lower its number — so the debt figures never
quietly become fiction. **If your change improves a baselined file, lowering
its number is part of your change**, not a follow-up.

Type scale: `text-sm` / `text-xs` / `text-[11px]` / `text-[10px]`. Do not invent
an off-grid size — `text-[12px]` is `text-xs` written the long way, and it also
opts out of the user's density preference, because `--ui-scale` reaches rem and
not px.

`npx vitest run src/lib/theme/` before you push.

## Every app renders through the theming engine — there are no app-local looks

*(Owner directive, 2026-08-10: "I want the UI for the projects to match the
theming configuration used in the Command Center… ensuring future development
considers it." It applies to every surface, not only Projects.)*

An app inside CommandCenter is a **projection of one product**, not a product
with its own visual identity. `/projects`, `/tasks`, `/email`, `/notes`, `/crm`
and everything after them draw from the same engine, so switching the org to
Fluent or Material or Graphite repaints all of them together. The moment one
app carries its own palette, that app is the one that looks broken on the day
somebody changes the theme — and nobody notices until then, because a hardcoded
value renders *fine*.

Four rules on top of the three above. Each one exists because it was broken:

4. **One vocabulary per concept, in `src/lib/` or `src/components/`, consumed by
   every app.** Status and lane colour is `src/lib/statusAccent.ts` — the single
   place a status, tag, board column, group header or pill becomes a hue. Before
   it there were three vocabularies plus a colour column
   (`pm_task_statuses.color`) that was stored and drawn nowhere, so every
   Projects board column rendered the same grey while the Tasks board next door
   was colour-coded. **Do not add a second palette.** If you need a hue a shared
   module does not express, extend the shared module.
5. **A category and a name must resolve to the same colour.** Some apps know
   what a lane *means* (Projects has `STATUS_CATEGORIES`); some can only read
   what it is *called* (Tasks' stages are user-typed). Those two routes must
   agree, or the same lane draws two colours in two apps. Fences:
   `test_category_and_keyword_agree` and, on the gateway side,
   `test_seed_status_colours_match_the_shared_vocabulary` — which reads
   `CATEGORY_HUES` out of the TypeScript rather than mirroring it, because a
   mirror goes stale and then lies. **Seeded data counts as a UI decision**: a
   stored colour outranks a derived one, so a seed that disagrees silently
   overrides the shared vocabulary on every uncustomised project.
6. **Use the house tokens, not a synonym.** Active/selected is
   `bg-primary/10 text-primary` (the measured norm across `/tasks`, `/email` and
   `src/components`), not `bg-accent`.
   Radius: **the whole named scale is derived from `--radius`** in `globals.css`'s
   `@theme` block — `sm`/`md` step down, `lg` and `xl` both *equal* `--radius`,
   `2xl`/`3xl` step up. So every `rounded-<name>` utility is themed and none of
   them is a violation; only an arbitrary value (`rounded-[14px]`) escapes the
   theme. What still matters is **consistency between surfaces**: two boards
   drawing their columns at different radii look like two products even when both
   are themed.
   *(Corrected 2026-08-10. This rule previously claimed `rounded-xl` was a fixed
   12px that ignored Graphite and Material. It is not — `--radius-xl:
   var(--radius)`, i.e. identical to `rounded-lg`. The claim was mine and it was
   wrong; acting on it would have baselined ~274 correctly-themed occurrences
   across ~70 files as debt, which is a fence against a non-violation and worse
   than no fence at all.)*
   **Fence (S4):** conformance rule 6 matches the PAIR
   `bg-accent text-accent-foreground` — a file with no budget must be clean, the
   four remaining sites are baselined per file and can only go down, and
   `lib/statusAccent.ts` is excepted with its argument. `hover:bg-accent` and
   `bg-accent/10` are deliberately not matched. The radius half is **advisory**: nothing tests it, and
   nothing should — see the correction above.
7. **Categorical hues are a theme decision too.** A set of colours that only
   has to be *mutually distinguishable* (contexts, tags, labels) still belongs to
   the theme. **The ramp now exists**: `--cat-1` … `--cat-8`, eight slots every
   theme supplies in both modes (WS-27af; values in `src/lib/theme/themes.ts`,
   class strings in **`src/lib/categorical.ts`** — `categoricalAccent(name)`,
   never a hand-written `bg-cat-*` table). Pick the slot by hashing the item's
   NAME, never by array index; never reorder the slots, which silently repaints
   everything already assigned. `app/tasks/lib/contextColors.ts` is the worked
   adapter — it keeps only the hand-assigned @context slots and delegates the
   rest, the same shape `stageColors.ts` has over `statusAccent.ts`.
   This does **not** compete with rule 4, it completes it: a status resolves to
   a **semantic** tone (its hue is information), a category resolves to a **ramp
   slot** (its hue is only an identity). Two concepts, two mechanisms, no third.
   ⚠️ `bg-sky-500/10` used to pass every conformance regex — it is a named class,
   not a bracket class — which is how ~950 of them accumulated. **CI catches it
   now** (conformance rule 5, per-file baselines that only go down), but the
   baseline is large: a file already in it can still get worse up to its budget.

**What CI cannot catch, and you must.** There is no structural or layout test in
this tree: nothing asserts panel counts, shell adoption, mobile branches, or that
two apps draw a card the same way. The conformance suite checks six regexes.
(`src/lib/sharedTaskUi.test.ts` is the nearest thing to a structural test and is
narrower than it sounds: it pins that a shared module is declared **once** and
that each app still imports it — never that a surface actually uses it.)
So the real check is `DESIGN_SYSTEM.md` §8: **switch the theme to Fluent, then
Material, then Graphite, and look at the surface you changed** — and at the
neighbouring app, because continuity between two apps is exactly what no test in
this repo measures. That check is what would have caught every divergence listed
above before it landed.
