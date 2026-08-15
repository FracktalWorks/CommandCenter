/**
 * People Center · the org chart, tree-building and its guards (WS-28c).
 *
 * Spec: `project-docs/specs/people_center_app.md` §5.4 · D-PC-14.
 *
 * The server sends a FLAT node list; the tree — and therefore the cycle guard
 * — lives here, where the recursion is. Two guards, one invariant each:
 *
 * * `buildTree` must terminate on ANY input: a manager loop in the data
 *   degrades to a labelled root, never a hang (§5.4: "a manager loop is a
 *   hang, not a diagram").
 * * `wouldCycle` refuses a re-parent BEFORE the request, so the tree never
 *   optimistically renders an impossible shape.
 */

export interface ChartNode {
  id: string;
  name: string;
  title?: string | null;
  department?: string | null;
  team?: string | null;
  avatar?: string | null;
  email?: string | null;
  status?: string | null;
  manager_id?: string | null;
  groups: string[];
}

export interface ChartGroup {
  slug: string;
  display_name: string;
}

export interface ChartResponse {
  nodes: ChartNode[];
  groups: ChartGroup[];
  can_manage: boolean;
}

export interface TreeNode {
  node: ChartNode;
  children: TreeNode[];
  /** True when this root was severed out of a manager loop. */
  cycle?: boolean;
}

export interface Tree {
  roots: TreeNode[];
  /** Every member of every severed loop — the page lists them as a defect. */
  cycleIds: string[];
}

/**
 * Flat nodes → forest. Children keep the server's (alphabetical) order.
 *
 * Cycle handling: a node whose ancestor chain never reaches a root is part of
 * a loop. The loop member with the smallest id is severed (rendered as a root
 * and flagged) — deterministic, so the same data always draws the same tree.
 */
export function buildTree(nodes: ChartNode[]): Tree {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // A manager off the list (the server already dropped alumni) is no manager.
  // A self-reference stays a "parent" so the cycle guard flags it, rather
  // than being smoothed into a plain root.
  const parentOf = (n: ChartNode): string | null =>
    n.manager_id && byId.has(n.manager_id) ? n.manager_id : null;
  const step = (n: ChartNode): ChartNode | undefined => {
    const p = parentOf(n);
    return p ? byId.get(p) : undefined;
  };

  // A node is in a loop iff walking its ancestors returns to it. Bounded by a
  // visited set, so this terminates on any input — which is the whole guard.
  const inLoop = (n: ChartNode): boolean => {
    const visited = new Set<string>();
    let cur = step(n);
    while (cur) {
      if (cur.id === n.id) return true;
      if (visited.has(cur.id)) return false;
      visited.add(cur.id);
      cur = step(cur);
    }
    return false;
  };

  const cycleIds = nodes.filter(inLoop).map((n) => n.id);
  // Sever exactly one member per loop — the smallest id, so the same data
  // always draws the same tree. Everything else in the loop (and anything
  // feeding into it) renders beneath the severed root.
  const severed = new Set<string>();
  const seen = new Set<string>();
  for (const id of cycleIds) {
    if (seen.has(id)) continue;
    const loop: string[] = [];
    let cur = byId.get(id);
    while (cur && !loop.includes(cur.id)) {
      loop.push(cur.id);
      seen.add(cur.id);
      cur = step(cur);
    }
    severed.add([...loop].sort()[0]);
  }

  const treeById = new Map<string, TreeNode>(
    nodes.map((n) => [n.id, { node: n, children: [] } as TreeNode])
  );
  const roots: TreeNode[] = [];
  for (const n of nodes) {
    const t = treeById.get(n.id)!;
    const p = parentOf(n);
    if (p && !severed.has(n.id)) {
      treeById.get(p)!.children.push(t);
    } else {
      if (severed.has(n.id)) t.cycle = true;
      roots.push(t);
    }
  }
  return { roots, cycleIds };
}

/**
 * Would putting `personId` under `newManagerId` close a loop? Walked over the
 * CURRENT nodes, bounded by a visited set so pre-existing bad data cannot
 * hang the check that exists to prevent bad data.
 */
export function wouldCycle(
  nodes: ChartNode[],
  personId: string,
  newManagerId: string
): boolean {
  if (personId === newManagerId) return true;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>();
  let cur = byId.get(newManagerId);
  while (cur) {
    if (cur.id === personId) return true;
    if (visited.has(cur.id)) return false;
    visited.add(cur.id);
    cur = cur.manager_id ? byId.get(cur.manager_id) : undefined;
  }
  return false;
}

/** `"R&D / Firmware"` → `"r-d-firmware"` — the same shape a group slug takes. */
export function slugify(department: string): string {
  return department
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * §5.4's overlay point: `department` is free text, group membership is the
 * real scoping, and where they disagree the chart SAYS so. One direction,
 * stated precisely: the department names an existing group and the person is
 * not in it. (Free text that names no group is not a mismatch — it is just
 * text.) Both sides are compared through `slugify`, because `r_d` is a legal
 * group slug and "R&D" must still find it.
 */
export function departmentMismatch(
  node: ChartNode,
  groupSlugs: ReadonlySet<string>
): string | null {
  if (!node.department) return null;
  const dept = slugify(node.department);
  if (!dept) return null;
  const match = [...groupSlugs].find((s) => slugify(s) === dept);
  if (!match) return null;
  if (node.groups.some((g) => slugify(g) === dept)) return null;
  return `“${node.department}” by department, but not in the ${match} group`;
}

/**
 * Search-to-focus: the ids that match the query, plus every ancestor — the
 * set the page keeps expanded so each match is visible in place.
 */
export function focusIds(nodes: ChartNode[], query: string): Set<string> {
  const q = query.trim().toLowerCase();
  if (!q) return new Set();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  for (const n of nodes) {
    const hay = `${n.name} ${n.title ?? ""} ${n.department ?? ""}`.toLowerCase();
    if (!hay.includes(q)) continue;
    out.add(n.id);
    const visited = new Set<string>();
    let cur = n.manager_id ? byId.get(n.manager_id) : undefined;
    while (cur && !visited.has(cur.id)) {
      out.add(cur.id);
      visited.add(cur.id);
      cur = cur.manager_id ? byId.get(cur.manager_id) : undefined;
    }
  }
  return out;
}
