// Images pasted into the composer (a screenshot, "copy image" in a browser).
import { classifyAttachment, isRejected, type PendingAttachment } from "./attachments";
import { savePastedImage } from "./openWebUiClient";

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export interface PastedImages {
  attachments: PendingAttachment[];
  errors: string[];
}

// The image files on a clipboard, ignoring everything else (pasted text must
// keep working normally).
export function imageFilesOf(clipboard: Pick<DataTransfer, "files"> | null | undefined): File[] {
  return [...(clipboard?.files ?? [])].filter((f) => f.type.startsWith("image/"));
}

// Saves each image to a file and turns it into an attachment. A format the chat
// doesn't accept (e.g. BMP) is reported instead of silently dropped.
export async function attachPastedImages(files: File[]): Promise<PastedImages> {
  const result: PastedImages = { attachments: [], errors: [] };
  for (const file of files) {
    const extension = EXTENSION_BY_TYPE[file.type];
    if (!extension) {
      result.errors.push(`Pasted ${file.type || "image"} isn't supported — use PNG, JPEG, GIF or WebP.`);
      continue;
    }
    try {
      const path = await savePastedImage(await file.arrayBuffer(), extension);
      const classified = classifyAttachment(path);
      if (isRejected(classified)) result.errors.push(classified.rejected);
      else result.attachments.push(classified);
    } catch (err) {
      result.errors.push(`Could not paste the image: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
