import { describe, expect, it } from "vitest";
import { groupByDate, toggleSection } from "./chatGroups";

// Wednesday 2026-10-21, 15:30 local time
const now = new Date(2026, 9, 21, 15, 30).getTime();
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const chat = (id: string, t: number) => ({ id, created_at: t, updated_at: t });

describe("groupByDate", () => {
  it("splits chats into today, yesterday, 7 days, 30 days and months", () => {
    const groups = groupByDate(
      [
        chat("a", at(2026, 10, 21, 8)),
        chat("b", at(2026, 10, 20, 23)),
        chat("c", at(2026, 10, 15)),
        chat("d", at(2026, 10, 2)),
        chat("e", at(2026, 8, 30)),
        chat("f", at(2025, 12, 1)),
      ],
      now,
    );
    expect(groups.map((g) => g.key)).toEqual([
      "today",
      "yesterday",
      "previous7",
      "previous30",
      "month-2026-08",
      "month-2025-12",
    ]);
    expect(groups[4].monthStart).toBe(new Date(2026, 7, 1).getTime());
  });

  it("uses calendar midnight, not 24-hour windows", () => {
    const groups = groupByDate([chat("a", at(2026, 10, 21, 0)), chat("b", at(2026, 10, 20, 23))], now);
    expect(groups.map((g) => g.key)).toEqual(["today", "yesterday"]);
  });

  it("puts the 7- and 30-day edges in the newer bucket", () => {
    const groups = groupByDate([chat("a", at(2026, 10, 14, 0)), chat("b", at(2026, 9, 21, 0))], now);
    expect(groups.map((g) => g.key)).toEqual(["previous7", "previous30"]);
  });

  it("sorts newest first inside a group and ignores input order", () => {
    const groups = groupByDate([chat("old", at(2026, 10, 21, 1)), chat("new", at(2026, 10, 21, 14))], now);
    expect(groups[0].items.map((c) => c.id)).toEqual(["new", "old"]);
  });

  it("falls back to created_at without updated_at and treats the future as today", () => {
    const groups = groupByDate(
      [
        { id: "a", created_at: at(2026, 10, 21, 9), updated_at: null },
        { id: "b", created_at: at(2026, 10, 25), updated_at: null },
      ],
      now,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("today");
  });

  it("returns no groups for no chats", () => {
    expect(groupByDate([], now)).toEqual([]);
  });
});

describe("toggleSection", () => {
  it("folds a section and unfolds it again without touching the others", () => {
    expect(toggleSection(["folders"], "chats")).toEqual(["folders", "chats"]);
    expect(toggleSection(["folders", "chats"], "folders")).toEqual(["chats"]);
  });
});
