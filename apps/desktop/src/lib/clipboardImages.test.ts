import { beforeEach, describe, expect, it, vi } from "vitest";

const savePastedImage = vi.fn(async (_bytes: ArrayBuffer, ext: string) => `C:\\tmp\\pasted-1.${ext}`);
vi.mock("./openWebUiClient", () => ({
  savePastedImage: (bytes: ArrayBuffer, ext: string) => savePastedImage(bytes, ext),
}));

const { attachPastedImages, imageFilesOf } = await import("./clipboardImages");

const file = (name: string, type: string) => new File([new Uint8Array([1, 2, 3])], name, { type });

beforeEach(() => savePastedImage.mockClear());

describe("imageFilesOf", () => {
  it("keeps only images and tolerates an empty clipboard", () => {
    expect(imageFilesOf(null)).toEqual([]);
    const files = [file("a.png", "image/png"), file("b.txt", "text/plain")] as unknown as FileList;
    expect(imageFilesOf({ files }).map((f) => f.name)).toEqual(["a.png"]);
  });
});

describe("attachPastedImages", () => {
  it("saves each image and returns it as an image attachment", async () => {
    const { attachments, errors } = await attachPastedImages([file("shot.png", "image/png"), file("p.jpg", "image/jpeg")]);
    expect(errors).toEqual([]);
    expect(savePastedImage.mock.calls.map((c) => c[1])).toEqual(["png", "jpg"]);
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toMatchObject({ kind: "image", mimeType: "image/png", filename: "pasted-1.png" });
  });

  it("reports formats the chat does not accept instead of dropping them silently", async () => {
    const { attachments, errors } = await attachPastedImages([file("x.bmp", "image/bmp")]);
    expect(attachments).toEqual([]);
    expect(errors[0]).toMatch(/PNG, JPEG, GIF or WebP/);
    expect(savePastedImage).not.toHaveBeenCalled();
  });

  it("reports a failed save and still handles the other images", async () => {
    savePastedImage.mockRejectedValueOnce(new Error("disk full"));
    const { attachments, errors } = await attachPastedImages([file("a.png", "image/png"), file("b.png", "image/png")]);
    expect(attachments).toHaveLength(1);
    expect(errors[0]).toContain("disk full");
  });
});
