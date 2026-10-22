import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryMemory, LibraryNote, LibraryPrompt } from "./library";

// --- in-memory stand-in for the local copy ---------------------------------
let prompts: LibraryPrompt[] = [];
let notes: LibraryNote[] = [];
let memories: LibraryMemory[] = [];

vi.mock("./library", () => ({
  listLibraryPrompts: vi.fn(async () => prompts.map((p) => ({ ...p }))),
  replaceLibraryPrompts: vi.fn(async (list: LibraryPrompt[]) => void (prompts = list.map((p) => ({ ...p })))),
  listLibraryNotes: vi.fn(async () => notes.map((n) => ({ ...n }))),
  replaceLibraryNotes: vi.fn(async (list: LibraryNote[]) => void (notes = list.map((n) => ({ ...n })))),
  upsertLibraryNote: vi.fn(async (n: LibraryNote) => {
    notes = [...notes.filter((x) => x.id !== n.id), { ...n }];
  }),
  deleteLibraryNote: vi.fn(async (id: string) => void (notes = notes.filter((n) => n.id !== id))),
  listLibraryMemories: vi.fn(async () => memories.map((m) => ({ ...m }))),
  replaceLibraryMemories: vi.fn(async (list: LibraryMemory[]) => void (memories = list.map((m) => ({ ...m })))),
  upsertLibraryMemory: vi.fn(async (m: LibraryMemory) => {
    memories = [...memories.filter((x) => x.id !== m.id), { ...m }];
  }),
  deleteLibraryMemory: vi.fn(async (id: string) => void (memories = memories.filter((m) => m.id !== id))),
}));

let session: { baseUrl: string; token: string } | null = { baseUrl: "http://srv", token: "t" };
vi.mock("./folderSync", () => ({ getSession: vi.fn(async () => session) }));

const serverNote = (over: Record<string, unknown> = {}) => ({
  id: "n1",
  title: "Plan",
  markdown: "# Plan",
  pinned: false,
  createdAt: 1000,
  updatedAt: 2000,
  ...over,
});
const api = {
  listPrompts: vi.fn(async () => [] as unknown[]),
  listNotes: vi.fn(async () => [] as unknown[]),
  listMemories: vi.fn(async () => [] as unknown[]),
  createNote: vi.fn(async () => serverNote()),
  updateNote: vi.fn(async () => serverNote({ title: "Plan 2", updatedAt: 3000 })),
  deleteNote: vi.fn(async () => {}),
  addMemory: vi.fn(async () => ({ id: "m1", content: "Likes tea", updatedAt: 5000 })),
  updateMemory: vi.fn(async () => ({ id: "m1", content: "Likes coffee", updatedAt: 6000 })),
  deleteMemory: vi.fn(async () => {}),
};
vi.mock("./openWebUiClient", () => api);

const { LIBRARY_UPDATED_EVENT, createMemory, createNote, pullLibrary, removeMemory, removeNote, saveMemory, saveNote } =
  await import("./librarySync");

beforeEach(() => {
  prompts = [];
  notes = [];
  memories = [];
  session = { baseUrl: "http://srv", token: "t" };
  vi.clearAllMocks();
  api.listPrompts.mockResolvedValue([]);
  api.listNotes.mockResolvedValue([]);
  api.listMemories.mockResolvedValue([]);
});

describe("pullLibrary", () => {
  it("does nothing without a session", async () => {
    session = null;
    expect(await pullLibrary()).toBe(false);
    expect(api.listNotes).not.toHaveBeenCalled();
  });

  it("copies prompts, notes and memories from the server and announces it", async () => {
    api.listPrompts.mockResolvedValue([{ id: "p1", command: "sum", name: "Summarize", content: "Summarize it" }]);
    api.listNotes.mockResolvedValue([serverNote()]);
    api.listMemories.mockResolvedValue([{ id: "m1", content: "Likes tea", updatedAt: 5000 }]);
    const heard = vi.fn();
    window.addEventListener(LIBRARY_UPDATED_EVENT, heard);

    expect(await pullLibrary()).toBe(true);
    window.removeEventListener(LIBRARY_UPDATED_EVENT, heard);

    expect(prompts).toEqual([{ id: "p1", command: "sum", name: "Summarize", content: "Summarize it" }]);
    expect(notes[0]).toMatchObject({ id: "n1", title: "Plan", markdown: "# Plan", pinned: 0, updated_at: 2000 });
    expect(memories).toEqual([{ id: "m1", content: "Likes tea", updated_at: 5000 }]);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("reports no change when nothing differs", async () => {
    api.listNotes.mockResolvedValue([serverNote()]);
    await pullLibrary();
    const heard = vi.fn();
    window.addEventListener(LIBRARY_UPDATED_EVENT, heard);
    expect(await pullLibrary()).toBe(false);
    window.removeEventListener(LIBRARY_UPDATED_EVENT, heard);
    expect(heard).not.toHaveBeenCalled();
  });

  it("lets the server win: edited and removed items follow it", async () => {
    notes = [
      { id: "n1", title: "Old", markdown: "old", pinned: 0, created_at: 1, updated_at: 1 },
      { id: "gone", title: "Deleted on the server", markdown: "", pinned: 0, created_at: 1, updated_at: 1 },
    ];
    api.listNotes.mockResolvedValue([serverNote({ title: "New", updatedAt: 9000 })]);
    await pullLibrary();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ id: "n1", title: "New", updated_at: 9000 });
  });

  it("an unavailable list leaves its local copy alone while the others still sync", async () => {
    notes = [{ id: "keep", title: "Keep", markdown: "", pinned: 0, created_at: 1, updated_at: 1 }];
    api.listNotes.mockRejectedValue(new Error("403"));
    api.listMemories.mockResolvedValue([{ id: "m1", content: "Likes tea", updatedAt: 5000 }]);
    expect(await pullLibrary()).toBe(true);
    expect(notes.map((n) => n.id)).toEqual(["keep"]);
    expect(memories).toHaveLength(1);
  });
});

describe("notes go to the server first", () => {
  it("creates and saves, keeping what the server returned", async () => {
    const created = await createNote("Plan", "# Plan");
    expect(created.outcome).toEqual({ synced: true });
    expect(api.createNote).toHaveBeenCalledWith("http://srv", "t", "Plan", "# Plan");
    expect(notes.map((n) => n.id)).toEqual(["n1"]);

    const saved = await saveNote("n1", "Plan 2", "text");
    expect(saved.note?.updated_at).toBe(3000);
    expect(notes[0].title).toBe("Plan 2");
  });

  it("changes nothing locally when the server refuses or there is no session", async () => {
    notes = [{ id: "n1", title: "Plan", markdown: "x", pinned: 0, created_at: 1, updated_at: 1 }];
    api.updateNote.mockRejectedValueOnce(new Error("500"));
    const failed = await saveNote("n1", "Changed", "y");
    expect(failed.outcome.synced).toBe(false);
    expect(notes[0].title).toBe("Plan");

    session = null;
    expect((await createNote("a", "b")).outcome.synced).toBe(false);
    expect((await removeNote("n1")).synced).toBe(false);
    expect(notes).toHaveLength(1);
  });

  it("deletes on the server and locally; a note already gone there counts as deleted", async () => {
    notes = [
      { id: "a", title: "A", markdown: "", pinned: 0, created_at: 1, updated_at: 1 },
      { id: "b", title: "B", markdown: "", pinned: 0, created_at: 1, updated_at: 1 },
    ];
    expect(await removeNote("a")).toEqual({ synced: true });
    api.deleteNote.mockRejectedValueOnce(new Error("failed (404 Not Found)"));
    expect(await removeNote("b")).toEqual({ synced: true });
    expect(notes).toHaveLength(0);

    notes = [{ id: "c", title: "C", markdown: "", pinned: 0, created_at: 1, updated_at: 1 }];
    api.deleteNote.mockRejectedValueOnce(new Error("could not reach http://srv"));
    expect((await removeNote("c")).synced).toBe(false);
    expect(notes).toHaveLength(1);
  });
});

describe("memories go to the server first", () => {
  it("adds, edits and removes", async () => {
    expect(await createMemory("Likes tea")).toEqual({ synced: true });
    expect(memories[0].content).toBe("Likes tea");
    expect(await saveMemory("m1", "Likes coffee")).toEqual({ synced: true });
    expect(memories[0].content).toBe("Likes coffee");
    expect(await removeMemory("m1")).toEqual({ synced: true });
    expect(memories).toHaveLength(0);
  });

  it("keeps the local copy when the server says no", async () => {
    memories = [{ id: "m1", content: "Likes tea", updated_at: 1 }];
    api.updateMemory.mockRejectedValueOnce(new Error("500"));
    expect((await saveMemory("m1", "x")).synced).toBe(false);
    api.deleteMemory.mockRejectedValueOnce(new Error("500"));
    expect((await removeMemory("m1")).synced).toBe(false);
    expect(memories[0].content).toBe("Likes tea");
  });
});
