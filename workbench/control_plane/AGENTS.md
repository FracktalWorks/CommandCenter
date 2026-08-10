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
2. **Never `import … from "lucide-react"`.** Use `<Icon name="Plus" />` — the
   active theme decides which pack draws it.
3. **Never hand-roll a control.** `Button` / `Input` / `Badge` from
   `src/components/ui/`. Material makes every button a pill, Graphite uppercases
   every label; no class string can express that.

All three are enforced by `src/lib/theme/conformance.test.ts`, which carries a
frozen baseline for existing debt: a file with no budget must be clean, a
baselined file may not get worse, and a baselined file that got *better* fails
until you lower its number — so the debt figures never quietly become fiction.

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
   `src/components`), not `bg-accent`. Radius comes from `--radius` via
   `rounded-sm/md/lg` — `rounded-xl` is a fixed 12px that ignores Graphite's
   `0.125rem` and Material's `1rem`.
7. **Categorical hues are a theme decision too.** A set of colours that only
   has to be *mutually distinguishable* (contexts, tags, labels) still belongs to
   the theme: use the categorical ramp, never a raw Tailwind palette class.
   `bg-sky-500/10` passes the conformance regex — it is a named class, not a
   bracket class — so this one is on you, not on CI.

**What CI cannot catch, and you must.** There is no structural or layout test in
this tree: nothing asserts panel counts, shell adoption, mobile branches, or that
two apps draw a card the same way. The conformance suite checks four regexes.
So the real check is `DESIGN_SYSTEM.md` §8: **switch the theme to Fluent, then
Material, then Graphite, and look at the surface you changed** — and at the
neighbouring app, because continuity between two apps is exactly what no test in
this repo measures. That check is what would have caught every divergence listed
above before it landed.
