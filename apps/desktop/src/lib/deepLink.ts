// opendesktopui:// links:
//   opendesktopui://chat/<id>        open a chat (the server's chat id, or the local one)
//   opendesktopui://new?q=<text>     start a new chat with the text in the composer

export type DeepLink = { kind: "chat"; id: string } | { kind: "new"; text: string };

export const DEEP_LINK_SCHEME = "opendesktopui:";

// What a link asks for, or null for anything that isn't one of ours or is malformed.
export function parseDeepLink(raw: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== DEEP_LINK_SCHEME) return null;

  // Some platforms hand over "opendesktopui:chat/<id>" without the slashes.
  const target = (url.host || url.pathname.replace(/^\/+/, "").split("/")[0]).toLowerCase();
  if (target === "chat") {
    const path = url.host ? url.pathname : url.pathname.replace(/^\/*chat/i, "");
    const id = decodeURIComponent(path.replace(/^\/+|\/+$/g, ""));
    return id && !id.includes("/") ? { kind: "chat", id } : null;
  }
  if (target === "new") {
    return { kind: "new", text: url.searchParams.get("q") ?? "" };
  }
  return null;
}
