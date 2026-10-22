// The system-wide shortcut that opens the quick chat window.
import { invoke } from "@tauri-apps/api/core";
import { isRegistered, register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { DEFAULT_QUICK_CHAT_SHORTCUT } from "./accelerator";

let current: string | null = null;
// Calls run one after the other: two overlapping ones (the effect running twice,
// a settings change right at start) would both see nothing registered yet.
let queue: Promise<void> = Promise.resolve();

// The accelerator the user configured: unset means the default, an empty string means off.
export function configuredShortcut(pref: string | undefined): string | null {
  if (pref === undefined) return DEFAULT_QUICK_CHAT_SHORTCUT;
  return pref.trim() === "" ? null : pref;
}

// Replaces the registered shortcut (null = none). Throws when the OS refuses it,
// typically because another application already owns that combination; the
// previous shortcut is gone by then, so the caller should report it.
export function applyQuickChatShortcut(accelerator: string | null): Promise<void> {
  const run = queue.then(() => apply(accelerator));
  queue = run.catch(() => undefined);
  return run;
}

async function apply(accelerator: string | null): Promise<void> {
  if (current) {
    try {
      await unregister(current);
    } catch {
      // already gone
    }
    current = null;
  }
  if (!accelerator) return;
  // A registration of this app that outlived the page (a reload) still holds the
  // combination; take it back. One held by another program stays, and register throws.
  try {
    if (await isRegistered(accelerator)) await unregister(accelerator);
  } catch {
    // register below reports what matters
  }
  await register(accelerator, (event) => {
    if (event.state === "Pressed") void invoke("show_quick_chat");
  });
  current = accelerator;
}
