// Prompts from the server's library are templates: `/summarize` inserts a text
// that may contain {{variables}}. Open WebUI fills a fixed set of them itself
// (date, user name, clipboard …); any other name is asked for.
import type { LibraryPrompt } from "./library";

const SYSTEM_VARIABLES = [
  "CLIPBOARD",
  "USER_NAME",
  "USER_LANGUAGE",
  "CURRENT_DATE",
  "CURRENT_TIME",
  "CURRENT_DATETIME",
  "CURRENT_TIMEZONE",
  "CURRENT_WEEKDAY",
] as const;

// {{name}} or {{name | type:property}} — the part after the bar describes the
// input field in the web UI and is not needed here.
const VARIABLE = /\{\{\s*([^{}|\s][^{}|]*?)\s*(?:\|[^{}]*)?\}\}/g;

export function usesVariable(content: string, name: string): boolean {
  return [...content.matchAll(VARIABLE)].some((m) => m[1] === name);
}

// The variables the user has to fill in: every name that isn't a system one,
// once each, in order of appearance.
export function customVariables(content: string): string[] {
  const names: string[] = [];
  for (const match of content.matchAll(VARIABLE)) {
    const name = match[1];
    if ((SYSTEM_VARIABLES as readonly string[]).includes(name)) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export interface SystemContext {
  now: Date;
  clipboard?: string;
  userName?: string;
  language?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

function systemValue(name: string, ctx: SystemContext): string | undefined {
  const d = ctx.now;
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  switch (name) {
    case "CLIPBOARD":
      return ctx.clipboard ?? "";
    case "USER_NAME":
      return ctx.userName ?? "";
    case "USER_LANGUAGE":
      return ctx.language ?? "";
    case "CURRENT_DATE":
      return date;
    case "CURRENT_TIME":
      return time;
    case "CURRENT_DATETIME":
      return `${date} ${time}`;
    case "CURRENT_TIMEZONE":
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    case "CURRENT_WEEKDAY":
      return d.toLocaleDateString("en-US", { weekday: "long" });
    default:
      return undefined;
  }
}

// The prompt text with every variable replaced: system ones from `ctx`, the
// others from `values`. A name with no value at all is left in the text.
export function fillVariables(content: string, values: Record<string, string>, ctx: SystemContext): string {
  return content.replace(VARIABLE, (whole, name: string) => {
    const system = systemValue(name, ctx);
    if (system !== undefined) return system;
    return name in values ? values[name] : whole;
  });
}

// What follows the slash while the user is typing a command: "/sum" -> "sum".
// Null once the text is anything else (a space ends the command).
export function commandQuery(text: string): string | null {
  const match = /^\/(\S*)$/.exec(text);
  return match ? match[1] : null;
}

// Prompts matching what was typed after the slash: those whose command starts
// with it first, then those that merely contain it (also in the name).
export function matchPrompts(prompts: LibraryPrompt[], query: string, limit = 8): LibraryPrompt[] {
  const q = query.toLowerCase();
  const starts = prompts.filter((p) => p.command.toLowerCase().startsWith(q));
  const rest = prompts.filter(
    (p) =>
      !starts.includes(p) && (p.command.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)),
  );
  return [...starts, ...rest].slice(0, limit);
}
