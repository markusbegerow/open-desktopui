export const AVATAR_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const AVATAR_SIZE = 256;

export function isAllowedAvatarExtension(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return AVATAR_EXTENSIONS.includes(ext);
}

// Open WebUI reports a generic placeholder when the account has no picture;
// that should fall back to the initial rather than be shown as an avatar.
export function isDefaultProfileImage(url: string | null | undefined): boolean {
  if (!url) return true;
  if (url.startsWith("data:")) return false;
  const path = url.split(/[?#]/)[0].toLowerCase();
  return path.endsWith("/user.png") || path.endsWith("/static/favicon.png");
}

// Manual upload wins, then the Open WebUI picture; undefined means "show the initial".
export function resolveAvatar(prefs: { avatar?: string; serverAvatar?: string } | null | undefined): string | undefined {
  return prefs?.avatar || prefs?.serverAvatar || undefined;
}

export function avatarInitial(name: string | undefined): string {
  return (name || "?")[0]?.toUpperCase() ?? "?";
}

export function hasTransparentPixels(rgba: ArrayLike<number>): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) return true;
  return false;
}

// WebP where the webview can encode it (Chromium/WebView2); WebKit
// (macOS/Linux) silently hands back PNG for that request, which is much
// larger for photos, so fall back to JPEG unless the picture has transparency.
export function encodeAvatarCanvas(canvas: Pick<HTMLCanvasElement, "toDataURL">, transparent: boolean): string {
  const webp = canvas.toDataURL("image/webp", 0.9);
  if (webp.startsWith("data:image/webp")) return webp;
  return transparent ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.85);
}

// Center-crops the image to a square and downscales it, so the stored data
// URL stays small regardless of the source photo's size.
export async function cropToSquareDataUrl(
  bytes: Uint8Array,
  size: number = AVATAR_SIZE,
): Promise<string> {
  // The browser sniffs the real format, so no mime type is needed.
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available");
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
    return encodeAvatarCanvas(canvas, hasTransparentPixels(ctx.getImageData(0, 0, size, size).data));
  } finally {
    bitmap.close();
  }
}
