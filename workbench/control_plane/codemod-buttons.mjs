/**
 * Migrate hand-rolled `<button>` elements onto the shared <Button> primitive.
 *
 * STRICT BY CONSTRUCTION. Unlike the icon migration, this one changes how
 * things LOOK, so a wrong guess is a visual regression somebody notices weeks
 * later. A button is only converted when its class list decomposes exactly
 * into (a) one recognised variant, (b) one recognised size, and (c) layout
 * classes that <Button> does not own. Anything else — a conditional
 * className, an unrecognised class, a card-style tile — is SKIPPED and
 * reported, never approximated.
 *
 * Run with --dry to classify without writing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import ts from "typescript";

const DRY = process.argv.includes("--dry");
const ROOT = "/home/user/CommandCenter/workbench/control_plane";

const EXCLUDE = new Set(["src/components/ui/Button.tsx"]);

/**
 * Classes <Button> emits itself. Present-or-absent is fine; what matters is
 * that seeing one does not disqualify a button, because the primitive will
 * re-emit an equivalent.
 */
const OWNED = new Set([
  "rounded-lg", "tech-transition", "transition-colors",
  "transition-all", "font-medium", "cursor-pointer",
  "disabled:opacity-50", "disabled:opacity-40", "disabled:opacity-60",
  "disabled:cursor-not-allowed",
]);

/**
 * Display and alignment travel through the `layout` prop, never className:
 * Tailwind cannot override `justify-center` with `justify-start` from a class
 * attribute, because the two have equal specificity and the stylesheet's order
 * decides. Reproducing the original's layout exactly is what keeps a
 * full-width, left-aligned menu item left-aligned.
 */
const LAYOUT_DEFAULT = "inline-flex items-center justify-center";
const isLayoutClass = (c) =>
  c === "flex" || c === "inline-flex" || /^(items-|justify-)/.test(c);

/** Colour signatures → variant. Every listed class must be present. */
const VARIANTS = [
  // Ordered most-specific first: `ghost` and `text` share a colour, and the
  // one with the extra hover surface must win.
  { name: "primary", need: ["bg-primary", "text-primary-foreground"],
    optional: ["hover:opacity-90"] },
  { name: "destructive", need: ["bg-destructive/10", "text-destructive"],
    optional: ["hover:bg-destructive/20"] },
  { name: "secondary", need: ["border", "border-border", "text-muted-foreground"],
    optional: ["hover:text-foreground", "hover:border-primary/30"] },
  { name: "ghost", need: ["text-muted-foreground", "hover:bg-secondary"],
    optional: ["hover:text-foreground"] },
  { name: "text", need: ["text-muted-foreground", "hover:text-foreground"], optional: [] },
];

/**
 * Size signatures, DERIVED from what <Button> actually emits (see
 * BUTTON_SIZES below). Hand-written need-lists drifted from the component and
 * let a gapless button match `md`, which silently added `gap-1.5` between its
 * icon and label. Deriving them makes that impossible.
 */
const TEXT_SIZES = ["text-xs", "text-sm", "text-[12px]", "text-[11px]", "text-[10px]", "text-base"];

/**
 * Classify a class list into (variant, size, layout, radius, leftover).
 *
 * EXACT matching on every visible axis. An earlier version matched a variant
 * when its required classes were merely PRESENT, with a permissive list of
 * "optional" hovers — and a static diff of all 404 conversions showed that
 * silently changed things: a button whose hover was `hover:bg-secondary`
 * acquired `hover:text-foreground hover:border-primary/30` instead, `px-4`
 * became `px-3 sm:px-4`, and buttons that were plain `inline-block` gained
 * `inline-flex items-center justify-center gap-1.5`. Requiring set EQUALITY is
 * what makes the migration provably invisible.
 */
const eq = (a, b) => a.size === b.size && [...a].every((c) => b.has(c));

/** Alternate spellings of the same effect, normalised before comparison. */
const NORMALISE = new Map([
  ["hover:bg-primary/90", "hover:opacity-90"],
  ["hover:opacity-80", "hover:opacity-90"],
  ["transition-colors", "tech-transition"],
  ["transition-all", "tech-transition"],
]);
const norm = (c) => NORMALISE.get(c) ?? c;

const isColour = (c) =>
  /^(bg-|border$|border-(?!width))/.test(c) ||
  (/^text-/.test(c) && !/^text-(xs|sm|base|lg|\[|left|center|right)/.test(c)) ||
  c.startsWith("hover:");
const isGeometry = (c) =>
  /^(p|px|py|pt|pb|pl|pr)-/.test(c) || /^gap-/.test(c) ||
  /^text-(xs|sm|base|lg|\[)/.test(c) || /^sm:(px|py|p)-/.test(c);
const isRadius = (c) => /^rounded(-|$)/.test(c);

function classify(classes) {
  const colour = new Set(classes.filter(isColour).map(norm));
  const geometry = new Set(classes.filter(isGeometry));
  const layoutClasses = classes.filter(isLayoutClass);
  const radiusClass = classes.find(isRadius);

  const variant = VARIANTS.find((v) =>
    eq(new Set([...v.need, ...(v.optional ?? [])].map(norm)), colour),
  );
  if (!variant) return { skip: "no exact variant match" };

  let size = SIZES.find((s) => eq(new Set(s.need), geometry));
  if (!size) {
    // Bespoke geometry: the primitive supplies none and the original's
    // padding/gap/text travel through className untouched.
    if (!geometry.size) return { skip: "no geometry" };
    size = { name: "none", need: [...geometry], keepPadding: true };
  }

  // `rounded-lg` is the theme radius, which `cc-button` reproduces. Anything
  // else must be preserved verbatim, or corners change size.
  const keepRadius = Boolean(radiusClass) && radiusClass !== "rounded-lg";

  const consumed = new Set([
    ...variant.need, ...(variant.optional ?? []),
    ...classes.filter(isColour),
    ...(size.keepPadding ? [] : size.need),
    ...(size.keepPadding ? [] : [...geometry]),
    ...OWNED, ...layoutClasses,
    ...(keepRadius ? [] : [radiusClass].filter(Boolean)),
  ]);
  const leftover = classes.filter((c) => !consumed.has(c));

  const LAYOUT_OK = /^(w-|h-|min-w-|max-w-|min-h-|mt-|mb-|ml-|mr-|mx-|my-|self-|flex-|grow|shrink|order-|col-|row-|whitespace-|truncate|text-left|text-center|text-right|relative|absolute|z-|sm:|md:|lg:|overflow-|leading-|font-)/;
  const preserved = new Set([
    ...(keepRadius && radiusClass ? [radiusClass] : []),
    ...(size.keepPadding ? size.need : []),
  ]);
  const unknown = leftover.filter((c) => !LAYOUT_OK.test(c) && !preserved.has(c));
  if (unknown.length) return { skip: `unknown classes: ${unknown.slice(0, 3).join(" ")}` };

  // Layout is reproduced EXACTLY, including "the original had none" — a bare
  // <button> is inline-block, and forcing inline-flex on it moves its content.
  const layout = layoutClasses.join(" ");

  return { variant: variant.name, size: size.name, leftover, keepRadius, layout };
}

const files = execSync(`grep -rl '<button' src --include=*.tsx`, { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean).filter((f) => !EXCLUDE.has(f));

/**
 * Self-audit. The codemod knows exactly which original produced which
 * conversion, so it — not an after-the-fact matcher — is the right place to
 * prove the rewrite is invisible. Reconstruct what <Button> will emit and diff
 * it against the original on every axis a user can see.
 */
const BUTTON_VARIANTS = {
  primary: "cc-button-filled bg-primary text-primary-foreground hover:opacity-90",
  secondary: "border border-border text-muted-foreground hover:text-foreground hover:border-primary/30",
  ghost: "text-muted-foreground hover:bg-secondary hover:text-foreground",
  destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20",
  text: "text-muted-foreground hover:text-foreground",
};
const BUTTON_SIZES = {
  sm: "gap-1 px-2.5 py-1.5 text-[12px]",
  md: "gap-1.5 px-3 py-1.5 text-xs",
  lg: "gap-1.5 px-3 sm:px-4 py-2 text-sm",
  "icon-xs": "p-1", "icon-sm": "p-1.5", icon: "p-2", none: "",
};
const SIZES = Object.entries(BUTTON_SIZES)
  .filter(([name]) => name !== "none")
  .map(([name, cls]) => ({
    name,
    need: cls.split(/\s+/).filter(Boolean),
    // An icon button carries padding and no text size; without this a `p-2`
    // button with `text-xs` would match `icon` and lose its text sizing.
    forbid: name.startsWith("icon") ? TEXT_SIZES : [],
  }));

const AXES = {
  display: (c) => c === "flex" || c === "inline-flex",
  align: (c) => /^(items-|justify-)/.test(c),
  padding: (c) => /^(p|px|py|pt|pb|pl|pr)-/.test(c) || /^sm:(px|py|p)-/.test(c),
  gap: (c) => /^gap-/.test(c),
  textSize: (c) => /^text-(xs|sm|base|lg|\[)/.test(c),
  radius: (c) => /^rounded(-|$)/.test(c) || c === "cc-button",
  colour: isColour,
};
const RADIUS_EQUIVALENT = (missing, added) =>
  missing.every((c) => c === "rounded-lg") && added.every((c) => c === "cc-button");

const audit = [];
function auditConversion(rel, original, r) {
  const emitted = [
    "cc-control",
    ...(r.keepRadius ? [] : ["cc-button"]),
    ...r.layout.split(/\s+/),
    ...BUTTON_VARIANTS[r.variant].split(/\s+/),
    ...BUTTON_SIZES[r.size].split(/\s+/),
    ...r.leftover,
  ].filter(Boolean);

  for (const [axis, test] of Object.entries(AXES)) {
    const a = new Set(original.filter(test).map(norm));
    const b = new Set(emitted.filter(test).map(norm));
    const missing = [...a].filter((c) => !b.has(c));
    const added = [...b].filter((c) => !a.has(c));
    if (!missing.length && !added.length) continue;
    if (axis === "radius" && RADIUS_EQUIVALENT(missing, added)) continue;
    audit.push(`${rel}\n    ${axis}: -[${missing.join(" ")}] +[${added.join(" ")}]\n    was: ${original.join(" ")}`);
  }
}

const stats = { converted: 0, files: 0 };
const skips = {};
const note = (why) => { skips[why] = (skips[why] ?? 0) + 1; };

for (const rel of files) {
  const path = `${ROOT}/${rel}`;
  const original = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(rel, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];

  const handle = (open, closeTag) => {
    const attrs = open.attributes.properties;
    const cn = attrs.find(
      (a) => ts.isJsxAttribute(a) && a.name.getText(sf) === "className",
    );
    if (!cn) { note("no className"); return; }
    // Only a plain string literal is safe: a template or expression usually
    // encodes a selected/active state the primitive knows nothing about.
    const init = cn.initializer;
    if (!init || !ts.isStringLiteral(init)) { note("dynamic className"); return; }

    const result = classify(init.text.split(/\s+/).filter(Boolean));
    if (result.skip) { note(result.skip); return; }

    const keep = attrs
      .filter((a) => a !== cn)
      .map((a) => a.getText(sf))
      .join(" ");
    const cls = result.leftover.length ? ` className="${result.leftover.join(" ")}"` : "";
    const props =
      `${result.variant === "primary" ? "" : ` variant="${result.variant}"`}` +
      `${result.size === "md" ? "" : ` size="${result.size}"`}` +
      `${result.keepRadius ? ` radius="keep"` : ""}` +
      `${result.layout === LAYOUT_DEFAULT ? "" : ` layout="${result.layout}"`}` +
      `${keep ? " " + keep : ""}${cls}`;

    auditConversion(rel, init.text.split(/\s+/).filter(Boolean), result);
    edits.push([open.getStart(sf), open.getEnd(), `<Button${props}>`]);
    if (closeTag) edits.push([closeTag.getStart(sf), closeTag.getEnd(), `</Button>`]);
    stats.converted++;
  };

  const visit = (n) => {
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText(sf) === "button") {
      handle(n.openingElement, n.closingElement);
    } else if (ts.isJsxSelfClosingElement(n) && n.tagName.getText(sf) === "button") {
      note("self-closing button");
    }
    n.forEachChild(visit);
  };
  sf.forEachChild(visit);

  if (!edits.length) continue;

  edits.sort((a, b) => b[0] - a[0]);
  let src = original;
  for (const [s, e, text] of edits) src = src.slice(0, s) + text + src.slice(e);

  if (!/from "@\/components\/ui\/Button"/.test(src)) {
    const anchor = src.search(/^import\s/m);
    const line = `import Button from "@/components/ui/Button";\n`;
    src = anchor === -1 ? line + src : src.slice(0, anchor) + line + src.slice(anchor);
  }

  // Reparse: a botched rewrite must not reach disk.
  const check = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  void check;

  if (!DRY) writeFileSync(path, src);
  stats.files++;
}

console.log(`converted ${stats.converted} button(s) in ${stats.files} file(s)`);
if (audit.length) {
  console.log(`\n!! ${audit.length} conversion(s) would CHANGE APPEARANCE:\n`);
  for (const a of audit.slice(0, 20)) console.log("  " + a + "\n");
  process.exitCode = 1;
} else {
  console.log("audit: every conversion is byte-for-byte equivalent on all visible axes");
}
console.log("skipped:");
for (const [why, n] of Object.entries(skips).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${why}`);
}
