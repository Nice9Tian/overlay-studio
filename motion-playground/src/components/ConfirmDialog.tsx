import { useEffect, useRef } from "react";
import "./ConfirmDialog.css";

export interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = "确定",
  cancelText = "取消",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const handlersRef = useRef({ onConfirm, onCancel });

  // Update handlers without triggering effects
  useEffect(() => {
    handlersRef.current = { onConfirm, onCancel };
  }, [onConfirm, onCancel]);

  useEffect(() => {
    if (!open) return;
    // 聚焦取消按钮
    cancelBtnRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handlersRef.current.onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        handlersRef.current.onConfirm();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  if (!open) return null;

  const lines = message.split("\n");

  return (
    <div className="confirm-backdrop" onClick={onCancel}>
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        {title && <div className="confirm-title">{title}</div>}
        <div className="confirm-message">
          {lines.map((line, i) => (
            <span key={i}>
              {line}
              {i < lines.length - 1 && <br />}
            </span>
          ))}
        </div>
        <div className="confirm-actions">
          <button
            className="confirm-btn confirm-btn-cancel"
            ref={cancelBtnRef}
            onClick={onCancel}
          >
            {cancelText}
          </button>
          <button className="confirm-btn confirm-btn-primary" onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
