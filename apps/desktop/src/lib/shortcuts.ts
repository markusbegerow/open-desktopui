// In-app keyboard shortcuts. "Mod" is Ctrl on Windows/Linux and Cmd on macOS.

export type ShortcutAction = "new-chat" | "search" | "settings";

export interface ShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

// What the app shows in Settings so the shortcuts can be found.
export const SHORTCUT_LIST: { action: ShortcutAction; keys: string }[] = [
  { action: "new-chat", keys: "Ctrl+N" },
  { action: "search", keys: "Ctrl+K" },
  { action: "settings", keys: "Ctrl+," },
];

// The action a key press stands for, or null for anything else. Keys with Shift
// or Alt are left alone: they belong to the OS and to text editing.
export function shortcutFor(e: ShortcutEvent): ShortcutAction | null {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return null;
  switch (e.key.toLowerCase()) {
    case "n":
      return "new-chat";
    case "k":
      return "search";
    case ",":
      return "settings";
    default:
      return null;
  }
}

// The sidebar listens for this to focus its search box (and open itself if collapsed).
export const FOCUS_SEARCH_EVENT = "opendesktopui:focus-search";
