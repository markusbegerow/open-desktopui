// Things that aren't files on disk but can still go into a chat as an
// attachment: a note, another chat, a web page or a screenshot. Text is saved
// as a markdown file and uploaded like any picked document.
import { classifyAttachment, isRejected, type PendingAttachment } from "./attachments";
import { savePastedImage, type ServerFile } from "./openWebUiClient";

function fileSafe(title: string): string {
  const cleaned = title.replace(/[\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 80);
  return cleaned || "attachment";
}

// Saves `body` as a .md file and returns it as an attachment named after `title`.
export async function markdownAttachment(title: string, body: string): Promise<PendingAttachment> {
  const bytes = new TextEncoder().encode(body);
  const path = await savePastedImage(bytes.buffer as ArrayBuffer, "md");
  const classified = classifyAttachment(path);
  if (isRejected(classified)) throw new Error(classified.rejected);
  return { ...classified, filename: `${fileSafe(title)}.md` };
}

export async function imageAttachment(bytes: ArrayBuffer, title: string): Promise<PendingAttachment> {
  const path = await savePastedImage(bytes, "png");
  const classified = classifyAttachment(path);
  if (isRejected(classified)) throw new Error(classified.rejected);
  return { ...classified, filename: `${fileSafe(title)}.png` };
}

// A file that is already on the server: nothing to upload, only to reference.
export function serverFileAttachment(file: ServerFile): PendingAttachment {
  return {
    id: crypto.randomUUID(),
    path: "",
    filename: file.filename,
    mimeType: file.mimeType,
    kind: file.mimeType.startsWith("image/") ? "image" : "document",
    uploadedId: file.id,
  };
}

export function chatTranscript(title: string, messages: Array<{ role: string; content: string }>): string {
  const body = messages
    .filter((m) => m.content.trim())
    .map((m) => `## ${m.role === "user" ? "User" : "Assistant"}\n\n${m.content.trim()}`)
    .join("\n\n");
  return `# ${title}\n\n${body}\n`;
}

// The readable text of an HTML page: no scripts, styles or page furniture.
export function htmlToText(html: string): { title: string; text: string } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript, svg, nav, header, footer, aside, form").forEach((el) => el.remove());
  const root = doc.querySelector("main, article") ?? doc.body;
  const text = (root?.textContent ?? "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: doc.title.trim(), text };
}

// One frame of the screen the user picks, as PNG bytes.
export async function captureScreenshot(): Promise<ArrayBuffer> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen capture isn't supported in this app.");
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 150)); // let the first real frame arrive
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not take the screenshot.");
    return await blob.arrayBuffer();
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}
