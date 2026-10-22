import { describe, expect, it } from "vitest";
import { imageDataUrl, sniffImageType } from "./imageData";

const bytes = (...b: number[]) => new Uint8Array(b);

describe("sniffImageType", () => {
  it("recognizes the formats a chat shows", () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d))).toBe("image/png");
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageType(bytes(0x47, 0x49, 0x46, 0x38, 0x39))).toBe("image/gif");
    expect(sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe("image/webp");
  });

  it("rejects everything else, including scripts disguised as images", () => {
    expect(sniffImageType(bytes())).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("<html>"))).toBeNull();
  });
});

describe("imageDataUrl", () => {
  it("builds a data URL with the sniffed type", () => {
    const url = imageDataUrl(bytes(0x89, 0x50, 0x4e, 0x47, 1, 2, 3).buffer);
    expect(url).toBe(`data:image/png;base64,${btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 1, 2, 3))}`);
  });

  it("returns null for a non-image", () => {
    expect(imageDataUrl(new TextEncoder().encode("hello").buffer)).toBeNull();
  });

  it("handles images larger than one conversion chunk", () => {
    const big = new Uint8Array(100_000);
    big.set([0xff, 0xd8, 0xff]);
    expect(imageDataUrl(big.buffer)?.startsWith("data:image/jpeg;base64,")).toBe(true);
  });
});
