import { describe, expect, it } from "vitest";
import { relativeTimeParts } from "./relativeTime";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTimeParts", () => {
  it("picks the coarsest unit that fits", () => {
    expect(relativeTimeParts(NOW - 20_000, NOW)).toEqual({ unit: "now", value: 0 });
    expect(relativeTimeParts(NOW - 5 * MIN, NOW)).toEqual({ unit: "minute", value: 5 });
    expect(relativeTimeParts(NOW - 3 * HOUR, NOW)).toEqual({ unit: "hour", value: 3 });
    expect(relativeTimeParts(NOW - 5 * DAY, NOW)).toEqual({ unit: "day", value: 5 });
    expect(relativeTimeParts(NOW - 7 * DAY, NOW)).toEqual({ unit: "week", value: 1 });
    expect(relativeTimeParts(NOW - 21 * DAY, NOW)).toEqual({ unit: "week", value: 3 });
    expect(relativeTimeParts(NOW - 90 * DAY, NOW)).toEqual({ unit: "month", value: 3 });
    expect(relativeTimeParts(NOW - 800 * DAY, NOW)).toEqual({ unit: "year", value: 2 });
  });

  it("treats a time in the future as now", () => {
    expect(relativeTimeParts(NOW + HOUR, NOW)).toEqual({ unit: "now", value: 0 });
  });
});
