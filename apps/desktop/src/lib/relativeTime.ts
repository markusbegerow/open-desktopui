// How long ago a chat was last active, in the coarse units the sidebar shows
// ("5 d", "1 w"). The texts come from the dictionary, this only picks the unit.

export type RelativeUnit = "now" | "minute" | "hour" | "day" | "week" | "month" | "year";

export interface RelativeTime {
  unit: RelativeUnit;
  value: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTimeParts(at: number, now: number = Date.now()): RelativeTime {
  const age = Math.max(0, now - at);
  if (age < MINUTE) return { unit: "now", value: 0 };
  if (age < HOUR) return { unit: "minute", value: Math.floor(age / MINUTE) };
  if (age < DAY) return { unit: "hour", value: Math.floor(age / HOUR) };
  const days = Math.floor(age / DAY);
  if (days < 7) return { unit: "day", value: days };
  if (days < 30) return { unit: "week", value: Math.floor(days / 7) };
  if (days < 365) return { unit: "month", value: Math.floor(days / 30) };
  return { unit: "year", value: Math.floor(days / 365) };
}
