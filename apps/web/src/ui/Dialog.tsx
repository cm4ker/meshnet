import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useBackLayer } from "../lib/back.js";
import { Button } from "./Button.js";

/**
 * A native `<dialog>`, opened modally so focus and Escape are the browser's.
 */
export function Dialog({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useBackLayer(open, onClose);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="dialog-inner" onClick={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <h2>{title}</h2>
        </header>
        <div className="dialog-body">{children}</div>
        {footer ? <footer className="dialog-foot">{footer}</footer> : null}
      </div>
    </dialog>
  );
}

/** A yes/no question whose answer is hard to take back. */
export function Confirm({
  open,
  title,
  body,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            variant={danger ? "danger" : "primary"}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}

/** One text answer. */
export function Prompt({
  open,
  title,
  label,
  placeholder,
  initial = "",
  type = "text",
  submitLabel = "OK",
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: string;
  label: string;
  placeholder?: string;
  initial?: string;
  type?: "text" | "password";
  submitLabel?: string;
  onSubmit: (value: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSubmit(value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} title={title} onClose={onCancel}>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span className="field-label">{label}</span>
          <input
            className="input"
            type={type}
            value={value}
            placeholder={placeholder}
            autoComplete={type === "password" ? "current-password" : "off"}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        </label>
        <div className="dialog-foot">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" type="submit" busy={busy}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
