// Local copies of the server's prompts, notes and memories, so they stay
// readable offline. The server is the source of truth: a successful pull
// replaces the whole local set, and changes are sent to the server first
// (see librarySync.ts).
import { currentAccountId, getDb } from "./chatHistory";

export interface LibraryPrompt {
  id: string;
  command: string; // without the leading slash
  name: string;
  content: string;
}

export interface LibraryNote {
  id: string;
  title: string;
  markdown: string;
  pinned: number; // 0/1
  created_at: number;
  updated_at: number;
}

export interface LibraryMemory {
  id: string;
  content: string;
  updated_at: number;
}

// --- prompts -----------------------------------------------------------------

export async function listLibraryPrompts(): Promise<LibraryPrompt[]> {
  const db = await getDb();
  return db.select<LibraryPrompt[]>(
    "SELECT id, command, name, content FROM library_prompts WHERE account_id = $1 ORDER BY command COLLATE NOCASE",
    [await currentAccountId()],
  );
}

export async function replaceLibraryPrompts(prompts: LibraryPrompt[]): Promise<void> {
  const db = await getDb();
  const accountId = await currentAccountId();
  await db.execute("DELETE FROM library_prompts WHERE account_id = $1", [accountId]);
  for (const p of prompts) {
    await db.execute(
      "INSERT OR REPLACE INTO library_prompts (id, account_id, command, name, content) VALUES ($1, $2, $3, $4, $5)",
      [p.id, accountId, p.command, p.name, p.content],
    );
  }
}

// --- notes -------------------------------------------------------------------

export async function listLibraryNotes(): Promise<LibraryNote[]> {
  const db = await getDb();
  return db.select<LibraryNote[]>(
    `SELECT id, title, markdown, pinned, created_at, updated_at FROM library_notes
     WHERE account_id = $1 ORDER BY pinned DESC, updated_at DESC`,
    [await currentAccountId()],
  );
}

export async function upsertLibraryNote(note: Omit<LibraryNote, "pinned"> & { pinned?: number }): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT OR REPLACE INTO library_notes (id, account_id, title, markdown, pinned, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [note.id, await currentAccountId(), note.title, note.markdown, note.pinned ?? 0, note.created_at, note.updated_at],
  );
}

export async function deleteLibraryNote(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM library_notes WHERE account_id = $1 AND id = $2", [await currentAccountId(), id]);
}

export async function replaceLibraryNotes(notes: LibraryNote[]): Promise<void> {
  const db = await getDb();
  const accountId = await currentAccountId();
  await db.execute("DELETE FROM library_notes WHERE account_id = $1", [accountId]);
  for (const n of notes) await upsertLibraryNote(n);
}

// --- memories ----------------------------------------------------------------

export async function listLibraryMemories(): Promise<LibraryMemory[]> {
  const db = await getDb();
  return db.select<LibraryMemory[]>(
    "SELECT id, content, updated_at FROM library_memories WHERE account_id = $1 ORDER BY updated_at DESC",
    [await currentAccountId()],
  );
}

export async function upsertLibraryMemory(memory: LibraryMemory): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT OR REPLACE INTO library_memories (id, account_id, content, updated_at) VALUES ($1, $2, $3, $4)",
    [memory.id, await currentAccountId(), memory.content, memory.updated_at],
  );
}

export async function deleteLibraryMemory(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM library_memories WHERE account_id = $1 AND id = $2", [await currentAccountId(), id]);
}

export async function replaceLibraryMemories(memories: LibraryMemory[]): Promise<void> {
  const db = await getDb();
  const accountId = await currentAccountId();
  await db.execute("DELETE FROM library_memories WHERE account_id = $1", [accountId]);
  for (const m of memories) await upsertLibraryMemory(m);
}
