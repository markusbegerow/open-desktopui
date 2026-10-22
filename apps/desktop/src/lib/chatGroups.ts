// Buckets the sidebar's chats by last activity the way Open WebUI does:
// Today, Yesterday, Previous 7 days, Previous 30 days, then one group per
// month. Day boundaries follow the local calendar, not 24-hour windows.

export type ChatDateBucket = "today" | "yesterday" | "previous7" | "previous30" | "month";

export interface ChatDateGroup<T> {
  // stable React key / i18n lookup: the bucket name, or `month-YYYY-MM`
  key: string;
  bucket: ChatDateBucket;
  // first instant of the month, only for `bucket === "month"` (label formatting)
  monthStart?: number;
  items: T[];
}

interface Dated {
  updated_at: number | null;
  created_at: number;
}

// Adds `key` to the collapsed sections, or removes it when it is already there.
export function toggleSection(collapsed: string[], key: string): string[] {
  return collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];
}

export function activityTime(item: Dated): number {
  return item.updated_at ?? item.created_at;
}

function startOfDay(ms: number): Date {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysBefore(day: Date, days: number): number {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - days).getTime();
}

export function groupByDate<T extends Dated>(items: T[], now: number = Date.now()): ChatDateGroup<T>[] {
  const today = startOfDay(now);
  const todayStart = today.getTime();
  const yesterdayStart = daysBefore(today, 1);
  const week = daysBefore(today, 7);
  const month = daysBefore(today, 30);

  const sorted = [...items].sort((a, b) => activityTime(b) - activityTime(a));
  const groups: ChatDateGroup<T>[] = [];
  const byKey = new Map<string, ChatDateGroup<T>>();

  for (const item of sorted) {
    const at = activityTime(item);
    let key: string;
    let bucket: ChatDateBucket;
    let monthStart: number | undefined;
    if (at >= todayStart) {
      key = bucket = "today";
    } else if (at >= yesterdayStart) {
      key = bucket = "yesterday";
    } else if (at >= week) {
      key = bucket = "previous7";
    } else if (at >= month) {
      key = bucket = "previous30";
    } else {
      const d = new Date(at);
      bucket = "month";
      key = `month-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    }
    let group = byKey.get(key);
    if (!group) {
      group = { key, bucket, monthStart, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
