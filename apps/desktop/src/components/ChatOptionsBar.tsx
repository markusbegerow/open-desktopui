import { useEffect, useRef, useState } from "react";
import {
  ChatFeatures,
  ChatSettings,
  availableFeatures,
  emptySettings,
} from "../lib/chatOptions";
import { useTranslation } from "../lib/i18n";
import type { OpenWebUiModel, ServerFeatures, ServerTool } from "../lib/openWebUiClient";

export interface ChatOptionsBarProps {
  settings: ChatSettings;
  onChange: (settings: ChatSettings) => void;
  model: OpenWebUiModel | undefined;
  serverFeatures: ServerFeatures | null;
  tools: ServerTool[];
}

// A text field for an optional number: empty means "not set".
function NumberField({
  label,
  value,
  step,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number | null;
  step: number;
  min?: number;
  max?: number;
  onCommit: (value: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => setText(value === null ? "" : String(value)), [value]);
  function commit() {
    const parsed = text.trim() === "" ? null : Number(text);
    onCommit(parsed === null || !Number.isFinite(parsed) ? null : parsed);
  }
  return (
    <label className="options-field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </label>
  );
}

// Feature switches, tools and the chat's own settings, next to the attach and
// mic buttons. A switch is only offered when the model supports it and the
// server has the feature on.
export default function ChatOptionsBar({ settings, onChange, model, serverFeatures, tools }: ChatOptionsBarProps) {
  const { t } = useTranslation();
  const available = availableFeatures(model, serverFeatures);
  const { params, features } = settings;

  const setFeature = (key: Exclude<keyof ChatFeatures, "toolIds">) =>
    onChange({ ...settings, features: { ...features, [key]: !features[key] } });
  const setParams = (patch: Partial<ChatSettings["params"]>) => onChange({ ...settings, params: { ...params, ...patch } });
  const toggleTool = (id: string) =>
    onChange({
      ...settings,
      features: {
        ...features,
        toolIds: features.toolIds.includes(id) ? features.toolIds.filter((x) => x !== id) : [...features.toolIds, id],
      },
    });

  const [systemText, setSystemText] = useState(params.system ?? "");
  useEffect(() => setSystemText(params.system ?? ""), [params.system]);
  const [stopText, setStopText] = useState(params.stop.join(", "));
  useEffect(() => setStopText(params.stop.join(", ")), [params.stop]);

  const switches: Array<{ key: Exclude<keyof ChatFeatures, "toolIds">; label: string; offered: boolean }> = [
    { key: "webSearch", label: t("options.webSearch"), offered: available.webSearch },
    { key: "imageGeneration", label: t("options.imageGeneration"), offered: available.imageGeneration },
    { key: "codeInterpreter", label: t("options.codeInterpreter"), offered: available.codeInterpreter },
    { key: "memory", label: t("options.memory"), offered: available.memory },
  ];
  const hasCustomSettings = JSON.stringify(params) !== JSON.stringify(emptySettings().params);
  const offeredSwitches = switches.filter((s) => s.offered);
  const anyActive =
    hasCustomSettings || features.toolIds.length > 0 || offeredSwitches.some((s) => features[s.key]);

  // One menu button; its panel opens above it and has a main list plus two
  // sub-pages (tools, chat settings). Clicking outside or pressing Esc closes it.
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"root" | "tools" | "settings">("root");
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const chevron = (
    <svg className="options-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  const subHeader = (label: string) => (
    <button type="button" className="options-back" onClick={() => setView("root")}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="m15 6-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{label}</span>
    </button>
  );

  return (
    <div className="options-popover" ref={rootRef}>
      <button
        type="button"
        className={`composer-icon-button${anyActive ? " active" : ""}`}
        title={t("options.menu")}
        aria-label={t("options.menu")}
        aria-expanded={open}
        onClick={() => {
          setView("root");
          setOpen((v) => !v);
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M4 7h9M17 7h3M4 17h3M11 17h9" strokeLinecap="round" />
          <circle cx="15" cy="7" r="2" />
          <circle cx="9" cy="17" r="2" />
        </svg>
      </button>

      {open && view === "root" && (
        <div className="options-menu">
          {tools.length > 0 && (
            <button type="button" className="options-row" onClick={() => setView("tools")}>
              <span className="options-row-label">{t("options.tools")}</span>
              {features.toolIds.length > 0 && <span className="options-count">{features.toolIds.length}</span>}
              {chevron}
            </button>
          )}
          {offeredSwitches.map((s) => (
            <button
              key={s.key}
              type="button"
              role="switch"
              aria-checked={features[s.key]}
              className="options-row"
              onClick={() => setFeature(s.key)}
            >
              <span className="options-row-label">{s.label}</span>
              <span className={`options-toggle${features[s.key] ? " on" : ""}`} aria-hidden="true" />
            </button>
          ))}
          <button type="button" className="options-row" onClick={() => setView("settings")}>
            <span className="options-row-label">{t("options.settings")}</span>
            {hasCustomSettings && <span className="options-count">•</span>}
            {chevron}
          </button>
        </div>
      )}

      {open && view === "tools" && (
        <div className="options-menu options-menu-wide">
          {subHeader(t("options.tools"))}
          <div className="options-tools">
            {tools.map((tool) => (
              <label key={tool.id} className="options-tool" title={tool.description ?? undefined}>
                <input type="checkbox" checked={features.toolIds.includes(tool.id)} onChange={() => toggleTool(tool.id)} />
                <span>{tool.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {open && view === "settings" && (
        <div className="options-menu options-menu-wide">
          {subHeader(t("options.settings"))}
          <div className="options-settings">
            <label className="options-field options-field-wide">
              <span>{t("options.systemPrompt")}</span>
              <textarea
                rows={4}
                value={systemText}
                placeholder={t("options.systemPromptHint")}
                onChange={(e) => setSystemText(e.target.value)}
                onBlur={() => setParams({ system: systemText.trim() === "" ? null : systemText })}
              />
            </label>
            <div className="options-grid">
              <NumberField label={t("options.temperature")} value={params.temperature} step={0.1} min={0} max={2} onCommit={(v) => setParams({ temperature: v })} />
              <NumberField label={t("options.topP")} value={params.top_p} step={0.05} min={0} max={1} onCommit={(v) => setParams({ top_p: v })} />
              <NumberField label={t("options.maxTokens")} value={params.max_tokens} step={1} min={1} onCommit={(v) => setParams({ max_tokens: v === null ? null : Math.round(v) })} />
              <NumberField label={t("options.seed")} value={params.seed} step={1} onCommit={(v) => setParams({ seed: v === null ? null : Math.round(v) })} />
            </div>
            <label className="options-field options-field-wide">
              <span>{t("options.stop")}</span>
              <input
                type="text"
                value={stopText}
                placeholder={t("options.stopHint")}
                onChange={(e) => setStopText(e.target.value)}
                onBlur={() =>
                  setParams({
                    stop: stopText
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <p className="hint">{t("options.hint")}</p>
            <button type="button" disabled={!hasCustomSettings} onClick={() => onChange({ ...settings, params: emptySettings().params })}>
              {t("options.reset")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
