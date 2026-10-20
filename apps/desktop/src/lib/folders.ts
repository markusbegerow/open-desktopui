import type { Group } from "./chatHistory";

export interface FolderNode {
  group: Group;
  depth: number;
  children: FolderNode[];
}

// Builds the sidebar's folder tree. A folder whose parent is missing (or part
// of a cycle) is shown at the top level instead of disappearing — the same
// repair Open WebUI applies to its own folder list.
export function buildFolderTree(groups: Group[]): FolderNode[] {
  const byId = new Map(groups.map((g) => [g.id, g]));

  function reachesRoot(g: Group): boolean {
    const seen = new Set<string>([g.id]);
    let current = g.parent_id ? byId.get(g.parent_id) : undefined;
    while (current) {
      if (seen.has(current.id)) return false;
      seen.add(current.id);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    return true;
  }

  const childrenOf = new Map<string | null, Group[]>();
  for (const g of groups) {
    const parent = g.parent_id && byId.has(g.parent_id) && reachesRoot(g) ? g.parent_id : null;
    const list = childrenOf.get(parent) ?? [];
    list.push(g);
    childrenOf.set(parent, list);
  }

  function build(parentId: string | null, depth: number): FolderNode[] {
    return (childrenOf.get(parentId) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .map((group) => ({ group, depth, children: build(group.id, depth + 1) }));
  }
  return build(null, 0);
}

// Flattens the tree in display order, skipping the contents of collapsed folders.
export function visibleFolders(tree: FolderNode[]): FolderNode[] {
  const out: FolderNode[] = [];
  for (const node of tree) {
    out.push(node);
    if (node.group.is_expanded) out.push(...visibleFolders(node.children));
  }
  return out;
}

// Every folder in display order (depth-first), regardless of expanded state.
export function flattenFolders(tree: FolderNode[]): FolderNode[] {
  return tree.flatMap((node) => [node, ...flattenFolders(node.children)]);
}

// Ids of `id` and everything nested below it.
export function subtreeIds(groups: Group[], id: string): Set<string> {
  const ids = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of groups) {
      if (g.parent_id && ids.has(g.parent_id) && !ids.has(g.id)) {
        ids.add(g.id);
        grew = true;
      }
    }
  }
  return ids;
}

// A folder can't be moved into itself or one of its own subfolders.
export function canMoveFolder(groups: Group[], id: string, newParentId: string | null): boolean {
  if (newParentId === null) return true;
  return !subtreeIds(groups, id).has(newParentId);
}

export function trimmedPrompt(group: Pick<Group, "system_prompt"> | null | undefined): string | null {
  const text = group?.system_prompt?.trim();
  return text ? text : null;
}
