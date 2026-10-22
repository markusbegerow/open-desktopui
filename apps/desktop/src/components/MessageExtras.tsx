import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "../lib/i18n";
import { normalizeSources } from "../lib/sources";

// The model's thinking, folded away under the answer it led to.
export function ReasoningBlock({
  text,
  seconds,
  thinking,
}: {
  text: string;
  seconds?: number;
  // the model is still thinking (the block stays open and says so)
  thinking?: boolean;
}) {
  const { t } = useTranslation();
  const summary = thinking
    ? t("answer.thinking")
    : seconds !== undefined
      ? `${t("answer.thoughtFor")} ${seconds} ${t("answer.seconds")}`
      : t("answer.thought");
  return (
    <details className="reasoning-block" open={thinking}>
      <summary>{summary}</summary>
      <div className="reasoning-text">{text}</div>
    </details>
  );
}

// What the answer was based on: documents of a knowledge base, web pages.
export function SourcesList({ sources }: { sources: unknown[] }) {
  const { t } = useTranslation();
  const citations = normalizeSources(sources);
  if (citations.length === 0) return null;
  return (
    <details className="sources-block">
      <summary>
        {t("answer.sources")} ({citations.length})
      </summary>
      <ol className="sources-list">
        {citations.map((c, i) => (
          <li key={`${c.name}-${i}`}>
            {c.url ? (
              <a
                href={c.url}
                onClick={(e) => {
                  e.preventDefault();
                  void openUrl(c.url!);
                }}
              >
                {c.name}
              </a>
            ) : (
              <span className="source-name">{c.name}</span>
            )}
            {c.snippet && <span className="source-snippet">{c.snippet}</span>}
          </li>
        ))}
      </ol>
    </details>
  );
}
