// Encrypted secret storage (API keys/tokens) via `tauri-plugin-stronghold`,
// replacing the plaintext `apiKey` fields `settingsStore.ts` used to write
// straight into its plain JSON store.
//
// Threat model, honestly stated: the vault's own unlock passphrase is a
// random value generated once per install and itself persisted via the
// plain (unencrypted) `tauri-plugin-store` file, since this is a
// single-user desktop app with no separate master-password UX. Anyone with
// full read access to the app's data directory can therefore still recover
// the passphrase and decrypt the vault — this does not defend against that.
// What it does provide: a secret value no longer appears as a recognizable
// plaintext string in `settings.json` (the file most likely to be casually
// viewed, screen-shared, synced to a backup, or scanned by something
// grepping for "sk-"-shaped tokens), and the vault itself is encrypted with
// an Argon2-derived key (`tauri-plugin-stronghold`'s own recommended KDF
// setup, wired in `lib.rs`) rather than stored as raw bytes.
import { Client, Stronghold } from "@tauri-apps/plugin-stronghold";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { load } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";

const VAULT_FILE = "vault.hold";
const CLIENT_NAME = "opendesktopui";
const PASSPHRASE_STORE_FILE = "settings.json";
const PASSPHRASE_KEY = "_vaultPassphrase";

interface VaultHandle {
  stronghold: Stronghold;
  client: Client;
}

let vaultPromise: Promise<VaultHandle> | null = null;

async function getOrCreatePassphrase(): Promise<string> {
  // Deliberately a separate `load()` call from settingsStore.ts's own,
  // rather than importing its `getStore()` — keeps this module
  // self-contained and avoids a circular dependency (settingsStore.ts will
  // call into this module, not the other way around). `tauri-plugin-store`
  // caches loaded stores by file path internally, so this doesn't create a
  // second on-disk file.
  const store = await load(PASSPHRASE_STORE_FILE, { autoSave: true });
  const existing = await store.get<string>(PASSPHRASE_KEY);
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const passphrase = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await store.set(PASSPHRASE_KEY, passphrase);
  // Flush now rather than relying on autoSave's debounce: if the app is
  // killed before that fires, the vault would later be encrypted with a
  // passphrase that was never persisted (-> BadFileKey on next launch).
  await store.save();
  return passphrase;
}

// Set when an unreadable vault was moved aside and recreated, so the UI can
// tell the user their saved credentials are gone and they must sign in again.
let vaultWasReset = false;
export function consumeVaultResetNotice(): boolean {
  const was = vaultWasReset;
  vaultWasReset = false;
  return was;
}

// The snapshot can't be decrypted with the current passphrase/salt (the age
// layer reports `BadFileKey`). Only this case justifies discarding the vault —
// a locked file or permission error is transient and must not wipe it.
export function isVaultDecryptError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /BadFileKey|failed to decode\/decrypt/i.test(message);
}

async function loadStronghold(path: string, passphrase: string): Promise<Stronghold> {
  try {
    return await Stronghold.load(path, passphrase);
  } catch (err) {
    if (!isVaultDecryptError(err)) throw err;
    // Move the unreadable snapshot aside and start fresh.
    console.warn("vault could not be decrypted, resetting:", err);
    await invoke("reset_vault");
    vaultWasReset = true;
    return await Stronghold.load(path, passphrase);
  }
}

async function getVault(): Promise<VaultHandle> {
  if (!vaultPromise) {
    vaultPromise = (async () => {
      const passphrase = await getOrCreatePassphrase();
      const path = await join(await appLocalDataDir(), VAULT_FILE);
      const stronghold = await loadStronghold(path, passphrase);
      let client: Client;
      try {
        client = await stronghold.loadClient(CLIENT_NAME);
      } catch {
        client = await stronghold.createClient(CLIENT_NAME);
      }
      return { stronghold, client };
    })().catch((err) => {
      vaultPromise = null;
      throw err;
    });
  }
  return vaultPromise;
}

export async function setSecret(key: string, value: string): Promise<void> {
  const { stronghold, client } = await getVault();
  const bytes = Array.from(new TextEncoder().encode(value));
  await client.getStore().insert(key, bytes);
  await stronghold.save();
}

export async function getSecret(key: string): Promise<string | null> {
  const { client } = await getVault();
  const bytes = await client.getStore().get(key);
  if (!bytes) return null;
  return new TextDecoder().decode(bytes);
}

export async function deleteSecret(key: string): Promise<void> {
  const { stronghold, client } = await getVault();
  await client.getStore().remove(key);
  await stronghold.save();
}
