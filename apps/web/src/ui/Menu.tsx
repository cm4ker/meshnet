/**
 * What else can be done with a row or a message: one menu, asked for by a
 * long press, a right click or a "More" button. With a mouse it opens where
 * the click was; on a phone it is a sheet of rows.
 */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { MenuAt } from "../lib/press.js";
import { useWide } from "../lib/layout.js";
import { dismissToast, useToast } from "../lib/toast.js";
import { AirMark } from "./List.js";
import { Sheet } from "./Sheet.js";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean | undefined;
  /** It transmits. */
  air?: boolean | undefined;
  disabled?: boolean | undefined;
  hint?: string | undefined;
}

interface MenuState {
  items: MenuItem[];
  title?: string | undefined;
  at: MenuAt;
}

let current: MenuState | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function showMenu(items: MenuItem[], options: { title?: string | undefined; at?: MenuAt } = {}): void {
  current = { items: items.filter(Boolean), title: options.title, at: options.at ?? null };
  emit();
}

export function closeMenu(): void {
  current = null;
  emit();
}

function useMenuState(): MenuState | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

function pick(item: MenuItem): void {
  closeMenu();
  item.onSelect();
}

export function MenuHost() {
  const menu = useMenuState();
  const wide = useWide();
  if (menu && wide && menu.at) return <Popover menu={menu} />;
  // Mounted while closed too, so the sheet can slide away with the menu it held.
  return (
    <Sheet open={menu !== null} onClose={closeMenu} title={menu?.title}>
      <div className="group-body">
        {menu?.items.map((item) => (
          <button key={item.label} type="button" className={["line", "line-action", item.danger ? "danger" : ""].join(" ")} disabled={item.disabled} onClick={() => pick(item)}>
            {item.icon ? <span className="line-icon">{item.icon}</span> : null}
            <span className="line-text">
              <span>{item.label}</span>
              {item.hint ? <small>{item.hint}</small> : null}
            </span>
            {item.air ? <AirMark /> : null}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

function Popover({ menu }: { menu: MenuState }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.at!.x, top: menu.at!.y });

  // Kept inside the window: flipped left or up when it would run off.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: menu.at!.x + width > window.innerWidth - 8 ? Math.max(8, menu.at!.x - width) : menu.at!.x,
      top: menu.at!.y + height > window.innerHeight - 8 ? Math.max(8, menu.at!.y - height) : menu.at!.y,
    });
  }, [menu]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    };
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) closeMenu();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", closeMenu);
    box.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", closeMenu);
    };
  }, []);

  return createPortal(
    <div ref={box} className="popover" role="menu" style={pos}>
      {menu.items.map((item) => (
        <button key={item.label} type="button" role="menuitem" className={item.danger ? "danger" : ""} disabled={item.disabled} onClick={() => pick(item)}>
          {item.icon ? <span className="popover-icon">{item.icon}</span> : null}
          <span>{item.label}</span>
          {item.air ? <AirMark /> : null}
        </button>
      ))}
    </div>,
    document.body,
  );
}

/**
 * Where the toast sits: just above the field being typed in, when one is
 * at the bottom of the screen (a chat, a console), so it covers no message;
 * else where the stylesheet puts it, above the tab bar. A distance from the
 * bottom, px, or null.
 */
function aboveComposer(): number | null {
  const fields = [...document.querySelectorAll<HTMLElement>(".compose, .composer")];
  const low = fields.map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0 && r.bottom > window.innerHeight - 160);
  if (low.length === 0) return null;
  const top = Math.min(...low.map((r) => r.top));
  return window.innerHeight - top + 8;
}

/** Seconds left for the action, and a ring that runs out with them. */
function Countdown({ ms }: { ms: number }) {
  const [left, setLeft] = useState(Math.ceil(ms / 1000));
  useEffect(() => {
    const end = Date.now() + ms;
    const tick = setInterval(() => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000))), 250);
    return () => clearInterval(tick);
  }, [ms]);
  return (
    <svg className="toast-ring" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8" className="toast-ring-track" />
      <circle cx="10" cy="10" r="8" className="toast-ring-run" style={{ animationDuration: `${ms}ms` }} transform="rotate(-90 10 10)" />
      <text x="10" y="13.5" textAnchor="middle">
        {left}
      </text>
    </svg>
  );
}

export function ToastHost() {
  const toast = useToast();
  const [bottom, setBottom] = useState<number | null>(null);
  const start = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!toast) return;
    const place = () => setBottom(aboveComposer());
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [toast]);
  if (!toast) return null;
  // A short note with nothing more to it hugs its text; the rest take the width.
  const short = !toast.action && !toast.detail && toast.tone !== "error";
  const icon = toast.tone === "error" ? "!" : toast.action ? "✓" : null;
  return createPortal(
    <div
      key={toast.id}
      className={["toast", toast.tone, short ? "short" : ""].join(" ")}
      role="status"
      style={bottom !== null ? { bottom } : undefined}
      // Pulled down, it goes.
      onPointerDown={(e) => (start.current = e.clientY)}
      onPointerMove={(e) => {
        if (start.current !== null && e.clientY - start.current > 24) {
          start.current = null;
          dismissToast();
        }
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
    >
      {icon ? (
        <span className="toast-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="toast-text">
        <span className="toast-main">{toast.text}</span>
        {toast.detail ? <span className="toast-detail">{toast.detail}</span> : null}
      </span>
      {toast.action ? (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            const run = toast.action!.run;
            dismissToast();
            run();
          }}
        >
          {toast.action.label}
          <Countdown ms={toast.ms} />
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
