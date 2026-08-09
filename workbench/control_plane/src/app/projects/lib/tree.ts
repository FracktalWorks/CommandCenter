/**
 * Projects · the project tree, and the Center slice.
 *
 * Spec: `project-docs/specs/project_management_app.md` §5 · D-PM-2.
 *
 * Pure functions. The `?center=` filter in particular is asserted here rather
 * than in a component, because its correctness claim is a *security* one and
 * needs to be checkable without rendering anything.
 */

export interface ProjectNode {
  id: string;
  name: string;
  parent_project_id?: string | null;
  status?: string | null;
  lead?: string | null;
  children?: ProjectNode[];
}

export interface ProjectGrant {
  project_id: string;
  subject: string;
}

/** Every id in a subtree, the node itself included. */
export function subtreeIds(node: ProjectNode): string[] {
  const out = [node.id];
  for (const child of node.children ?? []) out.push(...subtreeIds(child));
  return out;
}

/** Flatten a forest to `[node, depth]` pairs, for a sidebar that indents. */
export function flatten(
  nodes: readonly ProjectNode[],
  depth = 0
): Array<{ node: ProjectNode; depth: number }> {
  const out: Array<{ node: ProjectNode; depth: number }> = [];
  for (const node of nodes) {
    out.push({ node, depth });
    out.push(...flatten(node.children ?? [], depth + 1));
  }
  return out;
}

/**
 * The roots a Center's slice shows: those granted to `group:<slug>`.
 *
 * ⚠️ **Presentation only.** This narrows what the sidebar renders for a Center
 * link; it is NOT the access boundary. The server's grant model already
 * decided which projects came back at all, so a hand-edited `?center=` shows
 * nothing the caller could not already reach — it just shows a different
 * subset of it. Treating this as the boundary is the mistake `R9` exists to
 * name: hiding a control is a courtesy, the server check is the control.
 *
 * An unknown or absent slug returns the whole forest rather than an empty one:
 * a typo'd Center should look like "no filter", never like "you have nothing".
 */
export function filterByCenter(
  roots: readonly ProjectNode[],
  grants: readonly ProjectGrant[],
  centerSlug: string | null | undefined
): ProjectNode[] {
  const slug = (centerSlug ?? "").trim().toLowerCase();
  if (!slug) return [...roots];

  const subject = `group:${slug}`;
  const granted = new Set(
    grants
      .filter((g) => (g.subject ?? "").toLowerCase() === subject)
      .map((g) => g.project_id)
  );
  if (granted.size === 0) return [...roots];

  return roots.filter((root) => subtreeIds(root).some((id) => granted.has(id)));
}

/** A project and its ancestors, for a breadcrumb. */
export function pathTo(
  roots: readonly ProjectNode[],
  projectId: string
): ProjectNode[] {
  for (const root of roots) {
    if (root.id === projectId) return [root];
    const below = pathTo(root.children ?? [], projectId);
    if (below.length) return [root, ...below];
  }
  return [];
}

/**
 * Refuse a move that would put a project inside its own subtree.
 *
 * The server refuses this too (a depth-bounded ancestor walk). Checking here as
 * well is not redundancy for its own sake: it stops the UI from optimistically
 * rendering a tree that cannot exist, then snapping back on the 422.
 */
export function canMoveUnder(
  roots: readonly ProjectNode[],
  projectId: string,
  newParentId: string | null
): boolean {
  if (newParentId === null) return true;
  if (newParentId === projectId) return false;
  const path = pathTo(roots, projectId);
  const node = path[path.length - 1];
  if (!node) return true;
  return !subtreeIds(node).includes(newParentId);
}
