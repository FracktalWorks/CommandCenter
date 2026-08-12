/**
 * Resolving a task's Client and Programme from the typed tree.
 *
 * `pm_tasks` carries only `project_id`. The ancestry — which programme, which
 * client — lives in `pm_projects.kind` (migration 171, D-PM-2: one table,
 * typed, not a table per level). This walks the nested forest ONCE into a flat
 * map, so a 200-row table is 200 dictionary lookups rather than 200 walks.
 */

export interface TreeNode {
  id: string;
  name: string;
  kind?: string | null;
  children?: TreeNode[];
}

export interface Path {
  client: string | null;
  program: string | null;
}

/**
 * `{ [projectId]: { client, program } }` for every node in the forest.
 *
 * Resolved by KIND rather than by depth. Depth would be the obvious rule and it
 * is wrong: Zealics and JAC have no programme, so their projects hang directly
 * off the client and sit one level higher than M&M's. A depth rule would label
 * those clients as programmes.
 *
 * A node inherits its ancestors' client and programme AND contributes its own,
 * so the map answers for a client node, a programme node and a task's parent
 * alike — the caller does not have to know which kind it is holding.
 */
export function ancestry(forest: readonly TreeNode[]): Record<string, Path> {
  const out: Record<string, Path> = {};

  const walk = (nodes: readonly TreeNode[], inherited: Path): void => {
    for (const node of nodes) {
      const here: Path = {
        client: node.kind === "client" ? node.name : inherited.client,
        // A programme never overrides an outer programme — the tree does not
        // nest them, and if it ever did, the innermost is the one that matters.
        program: node.kind === "program" ? node.name : inherited.program,
      };
      out[node.id] = here;
      if (node.children?.length) walk(node.children, here);
    }
  };

  walk(forest, { client: null, program: null });
  return out;
}
