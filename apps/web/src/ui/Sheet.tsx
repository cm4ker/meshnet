import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useWide } from "../lib/layout.js";

/**
 * A sheet from the bottom of a phone's screen, pulled down or tapped past to
 * close; on a wide screen the same content in a dialog in the middle.
 */
export function Sheet({ open, onClose, title, children, className }: { open: boolean; onClose: () => void; title?: string | undefined; children: ReactNode; className?: string | undefined }) {
  const wide = useWide();
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(0);
  const from = useRef<number | null>(null);
  // Callers pass a fresh closure every render; the effect below runs once per opening.
  const close = useRef(onClose);
  close.current = onClose;
  // A sheet opened by a long press appears under the finger, and the click that ends the press
  // lands on the scrim. Only a press that began on the scrim is a tap past the sheet.
  const pressedScrim = useRef(false);

  useEffect(() => {
    if (!open) return;
    setDrag(0);
    pressedScrim.current = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    window.addEventListener("keydown", onKey, true);
    const before = document.activeElement as HTMLElement | null;
    box.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      before?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  const grab = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      from.current = e.clientY;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent) => {
      if (from.current !== null) setDrag(Math.max(0, e.clientY - from.current));
    },
    onPointerUp: () => {
      if (from.current === null) return;
      from.current = null;
      if (drag > 80) onClose();
      else setDrag(0);
    },
  };

  return createPortal(
    <div className={["sheet-layer", wide ? "wide" : ""].join(" ")}>
      <div
        className="sheet-scrim"
        onPointerDown={() => (pressedScrim.current = true)}
        onClick={() => {
          if (pressedScrim.current) onClose();
          pressedScrim.current = false;
        }}
      />
      <div
        ref={box}
        tabIndex={-1}
        className={["sheet", className ?? ""].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={drag ? { transform: `translateY(${drag}px)`, transition: "none" } : undefined}
      >
        {wide ? null : <div className="sheet-grab" {...grab} onPointerCancel={grab.onPointerUp} />}
        {title ? <h2 className="sheet-title">{title}</h2> : null}
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
