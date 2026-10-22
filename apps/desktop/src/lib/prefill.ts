// Text waiting to be put into the next composer that mounts (a
// `opendesktopui://new?q=…` link). Kept here because the composer's view is
// replaced when the link arrives; the app remounts it so it picks the text up.
let pending: string | null = null;

export function setPrefill(text: string) {
  pending = text;
}

// Hands the waiting text over once; null when there is none.
export function takePrefill(): string | null {
  const text = pending;
  pending = null;
  return text;
}
