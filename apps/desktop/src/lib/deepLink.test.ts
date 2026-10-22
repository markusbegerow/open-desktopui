import { describe, expect, it } from "vitest";
import { parseDeepLink } from "./deepLink";

describe("parseDeepLink", () => {
  it("opens a chat by id, tolerating a trailing slash and escapes", () => {
    expect(parseDeepLink("opendesktopui://chat/abc-123")).toEqual({ kind: "chat", id: "abc-123" });
    expect(parseDeepLink("opendesktopui://chat/abc-123/")).toEqual({ kind: "chat", id: "abc-123" });
    expect(parseDeepLink("opendesktopui://chat/a%20b")).toEqual({ kind: "chat", id: "a b" });
  });

  it("starts a new chat with optional text", () => {
    expect(parseDeepLink("opendesktopui://new?q=Hello%20world")).toEqual({ kind: "new", text: "Hello world" });
    expect(parseDeepLink("opendesktopui://new")).toEqual({ kind: "new", text: "" });
  });

  it("accepts the form without slashes some platforms deliver", () => {
    expect(parseDeepLink("opendesktopui:chat/abc")).toEqual({ kind: "chat", id: "abc" });
  });

  it("rejects other schemes, unknown targets, missing or nested ids and garbage", () => {
    expect(parseDeepLink("https://example.com/chat/abc")).toBeNull();
    expect(parseDeepLink("opendesktopui://settings")).toBeNull();
    expect(parseDeepLink("opendesktopui://chat")).toBeNull();
    expect(parseDeepLink("opendesktopui://chat/a/b")).toBeNull();
    expect(parseDeepLink("not a url")).toBeNull();
    expect(parseDeepLink("")).toBeNull();
  });
});
