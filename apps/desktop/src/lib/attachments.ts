// Shared allowlist + validation for document/image attachments, used
// identically by the window-level drag-drop listener (App.tsx) and the
// dialog-picker fallback (AttachButton.tsx) so both paths accept/reject the
// exact same files.

export interface PendingAttachment {
  id: string;
  path: string;
  filename: string;
  mimeType: string;
  kind: "image" | "document";
  uploadedId?: string;
}

export interface RejectedAttachment {
  rejected: string;
}

const DOCUMENT_EXTENSIONS = ["pdf", "txt", "md", "docx", "csv"];
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];

export const ALLOWED_EXTENSIONS = [...DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS];

const EXTENSION_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function extensionOf(path: string): string {
  const filename = filenameOf(path);
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

function filenameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function classifyAttachment(path: string): PendingAttachment | RejectedAttachment {
  const filename = filenameOf(path);
  const extension = extensionOf(path);
  if (!extension || !ALLOWED_EXTENSIONS.includes(extension)) {
    return { rejected: `"${filename}" isn't supported — attach a document (${DOCUMENT_EXTENSIONS.join(", ")}) or image (${IMAGE_EXTENSIONS.join(", ")}).` };
  }
  return {
    id: crypto.randomUUID(),
    path,
    filename,
    mimeType: EXTENSION_TO_MIME[extension] ?? "application/octet-stream",
    kind: IMAGE_EXTENSIONS.includes(extension) ? "image" : "document",
  };
}

export function isRejected(result: PendingAttachment | RejectedAttachment): result is RejectedAttachment {
  return "rejected" in result;
}
