import { describe, expect, it } from "vitest";
import type { Group } from "./chatHistory";
import { buildFolderTree, canMoveFolder, subtreeIds, trimmedPrompt, visibleFolders } from "./folders";

function g(id: string, name: string, parent: string | null = null, expanded = 1): Group {
  return {
    id,
    name,
    account_id: "a",
    created_at: 0,
    parent_id: parent,
    icon: null,
    system_prompt: null,
    is_expanded: expanded,
    openwebui_folder_id: null,
    updated_at: 0,
    dirty: 0,
  };
}

describe("buildFolderTree", () => {
  it("nests folders and sorts siblings by name", () => {
    const tree = buildFolderTree([g("2", "Work"), g("1", "Alpha"), g("3", "Sub", "2")]);
    expect(tree.map((n) => n.group.name)).toEqual(["Alpha", "Work"]);
    expect(tree[1].children.map((n) => n.group.name)).toEqual(["Sub"]);
    expect(tree[1].children[0].depth).toBe(1);
  });

  it("shows folders with a missing parent at the top level", () => {
    const tree = buildFolderTree([g("1", "Orphan", "gone")]);
    expect(tree.map((n) => n.group.id)).toEqual(["1"]);
  });

  it("breaks parent cycles instead of dropping the folders", () => {
    const tree = buildFolderTree([g("1", "A", "2"), g("2", "B", "1")]);
    expect(tree.map((n) => n.group.id).sort()).toEqual(["1", "2"]);
  });
});

describe("visibleFolders", () => {
  it("hides the contents of collapsed folders", () => {
    const tree = buildFolderTree([g("1", "A", null, 0), g("2", "B", "1"), g("3", "C")]);
    expect(visibleFolders(tree).map((n) => n.group.id)).toEqual(["1", "3"]);
  });
});

describe("moving folders", () => {
  const groups = [g("1", "A"), g("2", "B", "1"), g("3", "C", "2"), g("4", "D")];
  it("collects the whole subtree", () => {
    expect([...subtreeIds(groups, "1")].sort()).toEqual(["1", "2", "3"]);
  });
  it("rejects moving a folder into itself or its descendants", () => {
    expect(canMoveFolder(groups, "1", "1")).toBe(false);
    expect(canMoveFolder(groups, "1", "3")).toBe(false);
    expect(canMoveFolder(groups, "3", "1")).toBe(true);
    expect(canMoveFolder(groups, "3", null)).toBe(true);
  });
});

describe("trimmedPrompt", () => {
  it("returns null for blank prompts", () => {
    expect(trimmedPrompt({ system_prompt: "  " })).toBeNull();
    expect(trimmedPrompt({ system_prompt: " be brief " })).toBe("be brief");
    expect(trimmedPrompt(null)).toBeNull();
  });
});
