/**
 * What else can be done with a row or a message: one menu, asked for by a
 * long press, a right click or a "More" button. With a mouse it opens where
 * the click was; on a phone it is a sheet of rows.
 */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { MenuAt } from "../lib/press.js";
import { useWide } from "../lib/layout.js";
import { useToast } from "../lib/toast.js";
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
  if (!menu) return null;
  if (wide && menu.at) return <Popover menu={menu} />;
  return (
    <Sheet open onClose={closeMenu} title={menu.title}>
      <div className="group-body">
        {menu.items.map((item) => (
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

export function ToastHost() {
  const toast = useToast();
  if (!toast) return null;
  return createPortal(
    <div key={toast.id} className={["toast", toast.tone].join(" ")} role="status">
      {toast.text}
    </div>,
    document.body,
  );
}
