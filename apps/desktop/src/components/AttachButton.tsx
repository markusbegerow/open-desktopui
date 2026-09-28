import { open } from "@tauri-apps/plugin-dialog";
import { ALLOWED_EXTENSIONS, classifyAttachment, isRejected, PendingAttachment } from "../lib/attachments";
import { useTranslation } from "../lib/i18n";

export interface AttachButtonProps {
  onAdd: (attachments: PendingAttachment[]) => void;
  onError: (message: string) => void;
}

export default function AttachButton({ onAdd, onError }: AttachButtonProps) {
  const { t } = useTranslation();
  async function handleClick() {
    const selection = await open({
      multiple: true,
      filters: [{ name: "Documents & Images", extensions: ALLOWED_EXTENSIONS }],
    });
    if (!selection) return;
    const paths = Array.isArray(selection) ? selection : [selection];
    const results = paths.map(classifyAttachment);
    const accepted = results.filter((r): r is PendingAttachment => !isRejected(r));
    const rejected = results.filter(isRejected);
    if (accepted.length) onAdd(accepted);
    if (rejected.length) onError(rejected.map((r) => r.rejected).join(" "));
  }

  return (
    <button type="button" className="attach-button" onClick={handleClick} title={t("composer.attach")}>
      📎
    </button>
  );
}
