// Prompts, notes and memories of the signed-in Open WebUI account, kept in step
// the same way as the chats: the server is the source of truth, a successful
// pull replaces the local copy, and changes go to the server first (a failed
// change leaves the local copy as it was). Everything stays readable offline.
import { SyncOutcome, getSession } from "./folderSync";
import {
  LibraryMemory,
  LibraryNote,
  LibraryPrompt,
  deleteLibraryMemory,
  deleteLibraryNote,
  listLibraryMemories,
  listLibraryNotes,
  listLibraryPrompts,
  replaceLibraryMemories,
  replaceLibraryNotes,
  replaceLibraryPrompts,
  upsertLibraryMemory,
  upsertLibraryNote,
} from "./library";
import * as api from "./openWebUiClient";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const NO_SESSION: SyncOutcome = { synced: false, error: "Not signed in to Open WebUI" };

// Tells open views (the prompt palette, notes, memories) to reload from the database.
export const LIBRARY_UPDATED_EVENT = "opendesktopui:library-updated";

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Pulls all three lists. Each is independent: one the server won't give (feature
// switched off, no permission) leaves its local copy alone. Returns whether
// anything local changed. Never throws.
export async function pullLibrary(): Promise<boolean> {
  const session = await getSession();
  if (!session) return false;
  let changed = false;

  try {
    const prompts: LibraryPrompt[] = (await api.listPrompts(session.baseUrl, session.token)).map((p) => ({
      id: p.id,
      command: p.command,
      name: p.name,
      content: p.content,
    }));
    const sorted = (list: LibraryPrompt[]) => [...list].sort(byCommand);
    if (!same(sorted(prompts), sorted(await listLibraryPrompts()))) {
      await replaceLibraryPrompts(prompts);
      changed = true;
    }
  } catch {
    // prompts unavailable
  }

  try {
    const notes: LibraryNote[] = (await api.listNotes(session.baseUrl, session.token)).map((n) => ({
      id: n.id,
      title: n.title,
      markdown: n.markdown,
      pinned: n.pinned ? 1 : 0,
      created_at: n.createdAt,
      updated_at: n.updatedAt,
    }));
    const local = await listLibraryNotes();
    const signature = (list: LibraryNote[]) => list.map((n) => [n.id, n.updated_at, n.pinned]).sort().join("|");
    if (signature(notes) !== signature(local)) {
      await replaceLibraryNotes(notes);
      changed = true;
    }
  } catch {
    // notes unavailable
  }

  try {
    const memories: LibraryMemory[] = (await api.listMemories(session.baseUrl, session.token)).map((m) => ({
      id: m.id,
      content: m.content,
      updated_at: m.updatedAt,
    }));
    const local = await listLibraryMemories();
    const signature = (list: LibraryMemory[]) => list.map((m) => [m.id, m.updated_at].join(":")).sort().join("|");
    if (signature(memories) !== signature(local)) {
      await replaceLibraryMemories(memories);
      changed = true;
    }
  } catch {
    // memories unavailable
  }

  if (changed) window.dispatchEvent(new Event(LIBRARY_UPDATED_EVENT));
  return changed;
}

function byCommand(a: LibraryPrompt, b: LibraryPrompt): number {
  return a.command.localeCompare(b.command, undefined, { sensitivity: "base" });
}

// --- notes -------------------------------------------------------------------

function toLocalNote(n: api.ServerNote): LibraryNote {
  return {
    id: n.id,
    title: n.title,
    markdown: n.markdown,
    pinned: n.pinned ? 1 : 0,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
  };
}

export async function createNote(
  title: string,
  markdown: string,
): Promise<{ outcome: SyncOutcome; note?: LibraryNote }> {
  const session = await getSession();
  if (!session) return { outcome: NO_SESSION };
  try {
    const note = toLocalNote(await api.createNote(session.baseUrl, session.token, title, markdown));
    await upsertLibraryNote(note);
    return { outcome: { synced: true }, note };
  } catch (err) {
    return { outcome: { synced: false, error: errorText(err) } };
  }
}

export async function saveNote(
  id: string,
  title: string,
  markdown: string,
): Promise<{ outcome: SyncOutcome; note?: LibraryNote }> {
  const session = await getSession();
  if (!session) return { outcome: NO_SESSION };
  try {
    const note = toLocalNote(await api.updateNote(session.baseUrl, session.token, id, title, markdown));
    await upsertLibraryNote(note);
    return { outcome: { synced: true }, note };
  } catch (err) {
    return { outcome: { synced: false, error: errorText(err) } };
  }
}

export async function removeNote(id: string): Promise<SyncOutcome> {
  const session = await getSession();
  if (!session) return NO_SESSION;
  try {
    await api.deleteNote(session.baseUrl, session.token, id);
  } catch (err) {
    // Already gone on the server counts as deleted.
    if (!/\b404\b|not found/i.test(errorText(err))) return { synced: false, error: errorText(err) };
  }
  await deleteLibraryNote(id);
  return { synced: true };
}

// --- memories ----------------------------------------------------------------

export async function createMemory(content: string): Promise<SyncOutcome> {
  const session = await getSession();
  if (!session) return NO_SESSION;
  try {
    const m = await api.addMemory(session.baseUrl, session.token, content);
    await upsertLibraryMemory({ id: m.id, content: m.content, updated_at: m.updatedAt });
    return { synced: true };
  } catch (err) {
    return { synced: false, error: errorText(err) };
  }
}

export async function saveMemory(id: string, content: string): Promise<SyncOutcome> {
  const session = await getSession();
  if (!session) return NO_SESSION;
  try {
    const m = await api.updateMemory(session.baseUrl, session.token, id, content);
    await upsertLibraryMemory({ id: m.id, content: m.content, updated_at: m.updatedAt });
    return { synced: true };
  } catch (err) {
    return { synced: false, error: errorText(err) };
  }
}

export async function removeMemory(id: string): Promise<SyncOutcome> {
  const session = await getSession();
  if (!session) return NO_SESSION;
  try {
    await api.deleteMemory(session.baseUrl, session.token, id);
  } catch (err) {
    if (!/\b404\b|not found/i.test(errorText(err))) return { synced: false, error: errorText(err) };
  }
  await deleteLibraryMemory(id);
  return { synced: true };
}
