import { useEffect, useRef, useState } from "react";
import AttachButton from "./AttachButton";
import Composer, { ComposerHandle } from "./Composer";
import MicButton from "./MicButton";
import ModelPicker from "./ModelPicker";
import UsageOverview from "./UsageOverview";
import { getAppPrefs, getOpenWebUiConfig } from "../lib/settingsStore";
import { KnowledgeBase, listKnowledgeBases, listModels, OpenWebUiModel } from "../lib/openWebUiClient";
import type { PendingAttachment } from "../lib/attachments";
import { pickGreetingIndex, renderGreeting } from "../lib/greeting";
import ChatOptionsBar from "./ChatOptionsBar";
import { ChatSettings, emptySettings } from "../lib/chatOptions";
import { useServerOptions } from "../lib/useServerOptions";

export interface HomeViewProps {
  onSend: (
    text: string,
    model: string,
    knowledgeIds: string[],
    attachments: PendingAttachment[],
    settings: ChatSettings,
  ) => void;
  attachments: PendingAttachment[];
  onAddAttachments: (attachments: PendingAttachment[]) => void;
  onRemoveAttachment: (id: string) => void;
  onAttachmentError: (message: string) => void;
}

export default function HomeView({
  onSend,
  attachments,
  onAddAttachments,
  onRemoveAttachment,
  onAttachmentError,
}: HomeViewProps) {
  const [displayName, setDisplayName] = useState<string | undefined>(undefined);
  const [models, setModels] = useState<OpenWebUiModel[]>([]);
  const [model, setModel] = useState<string>("");
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | undefined>(undefined);
  const [micError, setMicError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ChatSettings>(() => emptySettings());
  const serverOptions = useServerOptions(baseUrl, apiKey);
  const composerRef = useRef<ComposerHandle>(null);
  const [greetingIndex] = useState(() => pickGreetingIndex());

  useEffect(() => {
    getAppPrefs().then((prefs) => setDisplayName(prefs?.displayName));
  }, []);

  useEffect(() => {
    (async () => {
      const config = await getOpenWebUiConfig();
      if (!config?.baseUrl) return;
      setBaseUrl(config.baseUrl);
      setApiKey(config.apiKey || undefined);

      setLoadingModels(true);
      try {
        const [modelList, kbList] = await Promise.all([
          listModels(config.baseUrl, config.apiKey || undefined),
          listKnowledgeBases(config.baseUrl, config.apiKey || undefined),
        ]);
        setModels(modelList);
        if (modelList.length > 0) {
          const prefs = await getAppPrefs();
          const preferred = prefs?.defaultModelId;
          const fallback = modelList.some((m) => m.id === preferred) ? preferred! : modelList[0].id;
          setModel((m) => m || fallback);
        }
        setKnowledgeBases(kbList);
      } finally {
        setLoadingModels(false);
      }
    })();
  }, []);

  function toggleKnowledgeBase(id: string) {
    setSelectedKnowledgeIds((prev) => (prev.includes(id) ? prev.filter((k) => k !== id) : [...prev, id]));
  }

  return (
    <div className="view home-view">
      <h1 className="home-greeting">{renderGreeting(greetingIndex, displayName)}</h1>

      <UsageOverview />

      {(selectedKnowledgeIds.length > 0 || attachments.length > 0) && (
        <div className="context-row">
          {(attachments.length > 0 || selectedKnowledgeIds.length > 0) && (
            <div className="attachment-chip-row">
              {selectedKnowledgeIds.map((id) => (
                <span key={id} className="attachment-chip">
                  <span className="attachment-chip-icon">🗄</span>
                  <span className="attachment-chip-name">{knowledgeBases.find((kb) => kb.id === id)?.name ?? id}</span>
                  <button
                    type="button"
                    className="attachment-chip-remove"
                    aria-label="Remove knowledge"
                    onClick={() => toggleKnowledgeBase(id)}
                  >
                    ×
                  </button>
                </span>
              ))}
              {attachments.map((a) => (
                <span key={a.id} className="attachment-chip">
                  <span className="attachment-chip-icon">{a.kind === "image" ? "🖼" : "📄"}</span>
                  <span className="attachment-chip-name">{a.filename}</span>
                  <button
                    type="button"
                    className="attachment-chip-remove"
                    aria-label={`Remove ${a.filename}`}
                    onClick={() => onRemoveAttachment(a.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="composer-card">
        <Composer
          ref={composerRef}
          onSend={(text, atts) => onSend(text, model, selectedKnowledgeIds, atts, settings)}
          disabled={!model}
          attachments={attachments}
          onPasteAttachments={onAddAttachments}
          onPasteError={onAttachmentError}
        />
        <div className="composer-toolbar">
          <div className="composer-toolbar-left">
            <AttachButton
              onAdd={onAddAttachments}
              onError={onAttachmentError}
              knowledgeBases={knowledgeBases}
              selectedKnowledgeIds={selectedKnowledgeIds}
              onToggleKnowledge={toggleKnowledgeBase}
            />
            <ChatOptionsBar
              settings={settings}
              onChange={setSettings}
              model={models.find((m) => m.id === model)}
              serverFeatures={serverOptions.features}
              tools={serverOptions.tools}
            />
          </div>
          <div className="composer-toolbar-right">
            <ModelPicker models={models} selectedId={model} onSelect={setModel} disabled={loadingModels} />
            <MicButton
              baseUrl={baseUrl}
              apiKey={apiKey}
              onResult={(text) => composerRef.current?.appendText(text)}
              onError={setMicError}
            />
          </div>
        </div>
      </div>
      {micError && <p className="status-error">{micError}</p>}
    </div>
  );
}
