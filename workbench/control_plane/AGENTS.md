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
