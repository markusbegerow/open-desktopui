import { useEffect, useState } from "react";
import {
  DailyActivity,
  getDailyActivity,
  getModelBreakdown,
  getStats,
  HistoryStats,
  ModelUsage,
} from "../lib/chatHistory";
import { formatCompact } from "../lib/format";

type Tab = "overview" | "models";
type Range = "all" | "30d" | "7d";

const RANGE_DAYS: Record<Range, number | undefined> = {
  all: undefined,
  "30d": 30,
  "7d": 7,
};

const HEATMAP_WEEKS = 10;

const MODEL_COLORS = [
  "#1d4ed8",
  "#3b82f6",
  "#60a5fa",
  "#93c5fd",
  "#bfdbfe",
  "#dbeafe",
];

export default function UsageOverview() {
  const [tab, setTab] = useState<Tab>("overview");
  const [range, setRange] = useState<Range>("all");
  const [activity, setActivity] = useState<DailyActivity[]>([]);
  const [models, setModels] = useState<ModelUsage[]>([]);
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [heatmap, setHeatmap] = useState<DailyActivity[]>([]);

  useEffect(() => {
    const days = RANGE_DAYS[range];
    (async () => {
      const [a, m] = await Promise.all([getDailyActivity(days), getModelBreakdown(days)]);
      setActivity(a);
      setModels(m);
    })();
  }, [range]);

  useEffect(() => {
    (async () => {
      const [s, h] = await Promise.all([getStats(), getDailyActivity(HEATMAP_WEEKS * 7)]);
      setStats(s);
      setHeatmap(h);
    })();
  }, []);

  return (
    <div className="usage-card">
      <div className="usage-header">
        <div className="usage-tabs">
          <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")} type="button">
            Overview
          </button>
          <button className={tab === "models" ? "active" : ""} onClick={() => setTab("models")} type="button">
            Models
          </button>
        </div>
        <div className="usage-range">
          <button className={range === "all" ? "active" : ""} onClick={() => setRange("all")} type="button">
            All
          </button>
          <button className={range === "30d" ? "active" : ""} onClick={() => setRange("30d")} type="button">
            30d
          </button>
          <button className={range === "7d" ? "active" : ""} onClick={() => setRange("7d")} type="button">
            7d
          </button>
        </div>
      </div>

      {tab === "overview" ? (
        <OverviewTab stats={stats} heatmap={heatmap} />
      ) : (
        <ModelsTab activity={activity} models={models} />
      )}
    </div>
  );
}

function OverviewTab({
  stats,
  heatmap,
}: {
  stats: HistoryStats | null;
  heatmap: DailyActivity[];
}) {
  const grid = buildActivityGrid(heatmap, HEATMAP_WEEKS);

  return (
    <>
      {stats && (
        <div className="stat-grid">
          <StatTile label="Sessions" value={stats.sessions} />
          <StatTile label="Messages" value={stats.messages} />
          <StatTile label="Total tokens" value={formatCompact(stats.totalTokens)} />
          <StatTile label="Active days" value={stats.activeDays} />
          <StatTile label="Peak hour" value={stats.peakHour !== null ? `${stats.peakHour}:00` : "—"} />
          <StatTile label="Favorite model" value={stats.favoriteModel ?? "—"} />
        </div>
      )}

      <div className="activity-grid" aria-label="Message activity by day">
        {grid.map((week, wi) => (
          <div className="activity-week" key={wi}>
            {week.map((day, di) => (
              <div
                key={di}
                className={`activity-cell activity-level-${day.level}`}
                title={day.day ? `${day.day}: ${day.count} messages` : ""}
              />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

function ModelsTab({ activity, models }: { activity: DailyActivity[]; models: ModelUsage[] }) {
  return (
    <>
      <TokenChart activity={activity} />
      <ModelBreakdownList models={models} />
    </>
  );
}

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function buildActivityGrid(activity: DailyActivity[], weeks: number) {
  const byDay = new Map(activity.map((a) => [a.day, a.count]));
  const maxCount = Math.max(1, ...activity.map((a) => a.count));

  const today = new Date();
  const days: { day: string; count: number; level: number }[] = [];
  for (let i = weeks * 7 - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const count = byDay.get(key) ?? 0;
    const level = count === 0 ? 0 : Math.min(4, Math.ceil((count / maxCount) * 4));
    days.push({ day: key, count, level });
  }

  const weekColumns: { day: string; count: number; level: number }[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    weekColumns.push(days.slice(i, i + 7));
  }
  return weekColumns;
}

function TokenChart({ activity }: { activity: DailyActivity[] }) {
  const totalTokens = activity.reduce((sum, a) => sum + a.tokens, 0);
  if (activity.length === 0 || totalTokens === 0) {
    return (
      <p className="hint">
        No token usage recorded yet — this server may not report token counts, or none of your
        messages have completed a response yet.
      </p>
    );
  }

  const maxTokens = Math.max(1, ...activity.map((a) => a.tokens));
  const labelEvery = Math.max(1, Math.ceil(activity.length / 6));
  const yTicks = [1, 0.75, 0.5, 0.25, 0].map((f) => Math.round(maxTokens * f));

  return (
    <div className="usage-chart-wrap">
      <div className="usage-chart-row">
        <div className="usage-chart-yaxis">
          {yTicks.map((tick, i) => (
            <span key={i}>{formatCompact(tick)}</span>
          ))}
        </div>
        <div className="usage-chart">
          {activity.map((a) => (
            <div
              key={a.day}
              className="usage-bar"
              style={{ height: `${(a.tokens / maxTokens) * 100}%` }}
              title={`${a.day}: ${formatCompact(a.tokens)} tokens, ${a.count} messages`}
            />
          ))}
        </div>
      </div>
      <div className="usage-chart-row">
        <div className="usage-chart-yaxis-spacer" />
        <div className="usage-chart-labels">
          {activity.map((a, i) => (
            <span key={a.day} className="usage-chart-label">
              {i % labelEvery === 0 ? formatAxisDate(a.day) : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function ModelBreakdownList({ models }: { models: ModelUsage[] }) {
  const grandTotal = models.reduce((sum, m) => sum + m.promptTokens + m.completionTokens, 0);
  if (models.length === 0 || grandTotal === 0) {
    return (
      <p className="hint">
        No token usage recorded yet — this server may not report token counts, or none of your
        messages have completed a response yet.
      </p>
    );
  }


  return (
    <div className="usage-model-list">
      {models.map((m, i) => {
        const total = m.promptTokens + m.completionTokens;
        const pct = grandTotal > 0 ? (total / grandTotal) * 100 : 0;
        return (
          <div className="usage-model-row" key={m.model}>
            <span className="usage-model-swatch" style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }} />
            <span className="usage-model-name">{m.model}</span>
            <span className="usage-model-detail">
              {formatCompact(m.promptTokens)} in · {formatCompact(m.completionTokens)} out
            </span>
            <span className="usage-model-pct">{pct.toFixed(1)}%</span>
          </div>
        );
      })}
    </div>
  );
}

function formatAxisDate(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
