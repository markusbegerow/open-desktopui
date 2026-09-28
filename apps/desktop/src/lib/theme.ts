export type Theme = "light" | "dark" | "system";

// The whole app renders via CSS system colors (`canvas`/`canvastext`) rather
// than hardcoded hex colors, driven by `color-scheme` — so forcing a theme
// is just overriding that one property. An inline style on the root element
// beats the `:root { color-scheme: light dark; }` rule in App.css purely on
// specificity, no other CSS changes needed.
export function applyTheme(theme: Theme): void {
  document.documentElement.style.colorScheme = theme === "system" ? "light dark" : theme;
}

export type ChatTextSize = "small" | "medium" | "large";

const CHAT_FONT_SIZES: Record<ChatTextSize, string> = {
  small: "13px",
  medium: "14px",
  large: "16px",
};

export function applyChatTextSize(size: ChatTextSize): void {
  document.documentElement.style.setProperty("--chat-font-size", CHAT_FONT_SIZES[size]);
}
