import { describe, expect, it } from "vitest";
import { ALLOWED_EXTENSIONS, classifyAttachment, isRejected } from "./attachments";

describe("classifyAttachment", () => {
  it.each(ALLOWED_EXTENSIONS)("accepts a .%s file", (extension) => {
    const result = classifyAttachment(`C:\\Users\\me\\Documents\\report.${extension}`);
    expect(isRejected(result)).toBe(false);
  });

  it("classifies image extensions as kind 'image'", () => {
    const result = classifyAttachment("photo.png");
    expect(isRejected(result)).toBe(false);
    if (!isRejected(result)) expect(result.kind).toBe("image");
  });

  it("classifies document extensions as kind 'document'", () => {
    const result = classifyAttachment("notes.pdf");
    expect(isRejected(result)).toBe(false);
    if (!isRejected(result)) expect(result.kind).toBe("document");
  });

  it("rejects a disallowed extension", () => {
    const result = classifyAttachment("archive.zip");
    expect(isRejected(result)).toBe(true);
  });

  it("rejects a file with no extension at all", () => {
    const result = classifyAttachment("README");
    expect(isRejected(result)).toBe(true);
  });

  it("is case-insensitive on the extension", () => {
    const result = classifyAttachment("SCAN.PDF");
    expect(isRejected(result)).toBe(false);
  });

  it("extracts the filename from a Windows-style path", () => {
    const result = classifyAttachment("C:\\path\\to\\image.png");
    expect(isRejected(result)).toBe(false);
    if (!isRejected(result)) expect(result.filename).toBe("image.png");
  });
});
