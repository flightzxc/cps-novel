"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { buttonClassName, type ButtonVariant } from "./button";

/**
 * Second confirmation for destructive operations (P1-09 acceptance ③).
 *
 * Uses the native `<dialog>` so focus trapping, Escape and the backdrop come
 * from the platform rather than a hand-rolled overlay. `onCancel` is wired
 * explicitly because Escape fires `cancel`, not `close`, and leaving it
 * unhandled would desync the parent's open state.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  confirmVariant = "danger",
  pending = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  confirmVariant?: ButtonVariant;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
      className="w-full max-w-md rounded-xl border border-gray-200 p-0 text-gray-900 shadow-xl backdrop:bg-gray-900/40"
    >
      <div className="space-y-4 p-5">
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="space-y-2 text-sm text-gray-600">{body}</div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={onCancel}
            className={buttonClassName("secondary")}
          >
            取消
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className={buttonClassName(confirmVariant)}
          >
            {pending ? "处理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
