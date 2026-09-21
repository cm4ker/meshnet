import type { ReactNode } from "react";
import { IconButton } from "../ui/Button.js";
import { BackIcon, CloseIcon } from "./Icons.js";

/** How a screen is left: back to the one under it on a phone, closed as the desktop's panel. */
export interface Chrome {
  onBack?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
}

export function ScreenHead({ chrome, children, actions }: { chrome: Chrome; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="screen-head">
      {chrome.onBack ? (
        <IconButton label="Back" onClick={chrome.onBack}>
          <BackIcon size={20} />
        </IconButton>
      ) : null}
      <div className="screen-title">{children}</div>
      {actions}
      {chrome.onClose ? (
        <IconButton label="Close · Esc" onClick={chrome.onClose}>
          <CloseIcon size={18} />
        </IconButton>
      ) : null}
    </header>
  );
}

/** A screen whose subject is gone: a contact removed, a channel cleared. */
export function Gone({ chrome, title, text }: { chrome: Chrome; title: string; text: string }) {
  return (
    <div className="screen">
      <ScreenHead chrome={chrome}>
        <span className="screen-name">{title}</span>
      </ScreenHead>
      <div className="empty muted">{text}</div>
    </div>
  );
}
