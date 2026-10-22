// Turns a key press into the accelerator string the global-shortcut plugin
// registers, e.g. "CommandOrControl+Alt+Space".

export const DEFAULT_QUICK_CHAT_SHORTCUT = "CommandOrControl+Alt+Space";

export interface AcceleratorEvent {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

// The key part, from `KeyboardEvent.code` (layout independent). Null for
// modifier keys on their own and for keys the plugin has no name for.
function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const named: Record<string, string> = {
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Semicolon: ";",
    Quote: "'",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
  };
  return named[code] ?? null;
}

// The accelerator for this key press, or null while the user is still holding
// modifiers, pressed an unnamed key, or used no modifier at all (a bare letter
// as a system-wide shortcut would swallow normal typing everywhere).
export function acceleratorFrom(e: AcceleratorEvent): string | null {
  const key = keyName(e.code);
  if (!key) return null;
  const modifiers: string[] = [];
  if (e.ctrlKey || e.metaKey) modifiers.push("CommandOrControl");
  if (e.altKey) modifiers.push("Alt");
  if (e.shiftKey) modifiers.push("Shift");
  if (modifiers.length === 0) return null;
  return [...modifiers, key].join("+");
}

// How the accelerator reads in the settings field.
export function acceleratorLabel(accelerator: string): string {
  return accelerator.replace("CommandOrControl", "Ctrl");
}
