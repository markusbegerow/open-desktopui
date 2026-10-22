import { describe, expect, it } from "vitest";
import { normalizeSources } from "./sources";

describe("normalizeSources", () => {
  it("names a knowledge-base file by its source name and quotes the start of the text", () => {
    const [c] = normalizeSources([
      { source: { id: "f1", name: "handbook.pdf" }, document: ["Chapter one. ".repeat(40)], metadata: [{ source: "handbook.pdf" }] },
    ]);
    expect(c.name).toBe("handbook.pdf");
    expect(c.url).toBeUndefined();
    expect(c.snippet?.endsWith("…")).toBe(true);
    expect(c.snippet?.length).toBeLessThanOrEqual(222);
  });

  it("links web results", () => {
    const [c] = normalizeSources([
      { source: { name: "Example" }, document: ["text"], metadata: [{ source: "https://example.com/a" }] },
    ]);
    expect(c).toEqual({ name: "Example", url: "https://example.com/a", snippet: "text" });
  });

  it("falls back to the metadata and the id for the name", () => {
    expect(normalizeSources([{ source: { id: "abc" }, metadata: [{ name: "From metadata" }] }])[0].name).toBe("From metadata");
    expect(normalizeSources([{ source: { id: "abc" } }])[0].name).toBe("abc");
  });

  it("lists a source once even when several passages of it were used", () => {
    const list = normalizeSources([
      { source: { name: "a.pdf" }, document: ["one"] },
      { source: { name: "a.pdf" }, document: ["two"] },
      { source: { name: "b.pdf" }, document: ["three"] },
    ]);
    expect(list.map((c) => c.name)).toEqual(["a.pdf", "b.pdf"]);
  });

  it("only links http(s) addresses and skips what it cannot read", () => {
    expect(normalizeSources([{ source: { name: "x" }, metadata: [{ source: "javascript:alert(1)" }] }])[0].url).toBeUndefined();
    expect(normalizeSources([null, 5, "x", {}, { source: {} }])).toEqual([]);
    expect(normalizeSources(undefined)).toEqual([]);
    expect(normalizeSources({})).toEqual([]);
  });
});
