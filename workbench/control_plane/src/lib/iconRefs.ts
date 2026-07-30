/**
 * iconRefs — find the icon names an artifact's own SOURCE asks for.
 *
 * Pure string scanning, kept apart from iconSvg.ts so it carries no React /
 * react-dom-server dependency: this is the half that runs in the node-environment
 * unit tests, and the half a caller can use before deciding to resolve anything.
 */

/**
 * Inline generative-UI cards declare their icons in `props.icons`, but a
 * full-page artifact is just a file — there is no place to declare anything. So
 * those frames used to receive NO icon map at all: `ccIcon()` returned "" and
 * every `[data-cc-icon]` placeholder stayed empty, which is a large part of why
 * "logos didn't show up".
 *
 * Scanning the source is precise (only what is referenced is injected, so the
 * srcDoc stays small) and needs nothing from the agent beyond using the icon the
 * normal way. Recognises all three spellings:
 *   <Icon name="rocket" />        — the @cc/ui component
 *   <span data-cc-icon="rocket">  — raw HTML
 *   ccIcon("rocket")              — script
 *
 * The name must be a literal: resolution happens on the parent, before the frame
 * ever runs, so a name computed at runtime cannot be seen.
 */
export function iconsUsedIn(source: string): string[] {
  if (!source) return [];
  const patterns = [
    /\bdata-cc-icon\s*=\s*["']([\w-]+)["']/g,
    /\bccIcon\(\s*["']([\w-]+)["']/g,
    /<Icon\b[^>]*?\bname\s*=\s*["']([\w-]+)["']/g,
  ];
  const found = new Set<string>();
  for (const re of patterns) {
    for (const m of source.matchAll(re)) found.add(m[1]);
  }
  return [...found];
}
