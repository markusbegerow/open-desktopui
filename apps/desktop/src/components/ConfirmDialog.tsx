import { useTranslation } from "../lib/i18n";

export interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const resolvedConfirmLabel = confirmLabel ?? t("confirmDialog.confirm");
  const resolvedCancelLabel = cancelLabel ?? t("confirmDialog.cancel");
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p className="hint">{message}</p>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            {resolvedCancelLabel}
          </button>
          <button type="button" className={danger ? "modal-button-danger" : ""} onClick={onConfirm}>
            {resolvedConfirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
