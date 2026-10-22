// What an answer was based on. Open WebUI sends `sources` as a list of
// { source: {id, name, type, url?}, document: [text…], metadata: [{source, name?, …}], distances }
// — one entry per retrieved item, with the text parts that were used.

export interface Citation {
  name: string;
  // a link that opens in the browser, when the source is a web page
  url?: string;
  // the start of the retrieved text
  snippet?: string;
}

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isWebUrl(value: string | undefined): value is string {
  return !!value && /^https?:\/\//i.test(value);
}

const SNIPPET_LENGTH = 220;

// One citation per distinct source, in order. Unknown shapes are skipped, not an error.
export function normalizeSources(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Map<string, Citation>();
  for (const entry of raw) {
    const item = asRecord(entry);
    if (!item) continue;
    const source = asRecord(item.source);
    const metadata = Array.isArray(item.metadata) ? asRecord(item.metadata[0]) : undefined;
    const documents = Array.isArray(item.document) ? item.document : [];

    const metaSource = asString(metadata?.source);
    const url = [asString(source?.url), metaSource].find(isWebUrl);
    const name =
      asString(source?.name) ?? asString(metadata?.name) ?? metaSource ?? asString(source?.id) ?? url;
    if (!name) continue;

    const text = asString(documents[0]);
    const snippet = text ? (text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH).trimEnd()}…` : text) : undefined;
    const key = url ?? name;
    if (!seen.has(key)) seen.set(key, { name, url, snippet });
  }
  return [...seen.values()];
}
