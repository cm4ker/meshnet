import type { ReactNode } from "react";
import { AirIcon, ChevronRightIcon } from "../components/Icons.js";

/**
 * Grouped rows, the way a phone's settings are laid out: a group is a
 * rounded block with an optional caption, a row a label with its value or
 * control at the right edge. A row that opens something has a chevron; one
 * that transmits carries the air mark.
 */
export function Group({ title, children, note }: { title?: ReactNode; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="group">
      {title ? <div className="group-title">{title}</div> : null}
      <div className="group-body">{children}</div>
      {note ? <p className="group-note">{note}</p> : null}
    </div>
  );
}

interface RowBase {
  label: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
}

function Text({ label, hint }: { label: ReactNode; hint?: ReactNode }) {
  return (
    <span className="line-text">
      <span>{label}</span>
      {hint ? <small>{hint}</small> : null}
    </span>
  );
}

/** Opens a screen or a sheet. */
export function LinkRow({ label, hint, icon, value, onClick, disabled, tone, trailing, selected }: RowBase & { value?: ReactNode; onClick: () => void; disabled?: boolean | undefined; tone?: "danger" | "warn" | "accent" | undefined; trailing?: ReactNode; selected?: boolean | undefined }) {
  return (
    <button type="button" className={["line", "line-link", tone ?? "", selected ? "selected" : ""].join(" ")} aria-current={selected ? "page" : undefined} onClick={onClick} disabled={disabled}>
      {icon ? <span className="line-icon">{icon}</span> : null}
      <Text label={label} hint={hint} />
      {value !== undefined ? <span className="line-value">{value}</span> : null}
      {trailing ?? <ChevronRightIcon size={14} className="line-chev" />}
    </button>
  );
}

/** Does something right away. */
export function ActionRow({ label, hint, icon, onClick, disabled, danger, air, busy }: RowBase & { onClick: () => void; disabled?: boolean | undefined; danger?: boolean | undefined; air?: boolean | undefined; busy?: boolean | undefined }) {
  return (
    <button type="button" className={["line", "line-action", danger ? "danger" : ""].join(" ")} onClick={onClick} disabled={disabled || busy}>
      {icon ? <span className="line-icon">{icon}</span> : null}
      <Text label={label} hint={hint} />
      {busy ? <span className="spinner" aria-hidden="true" /> : air ? <AirMark /> : null}
    </button>
  );
}

export function SwitchRow({ label, hint, icon, checked, onChange, disabled }: RowBase & { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean | undefined }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="line line-switch" onClick={() => onChange(!checked)} disabled={disabled}>
      {icon ? <span className="line-icon">{icon}</span> : null}
      <Text label={label} hint={hint} />
      <span className={["switch", checked ? "on" : ""].join(" ")} aria-hidden="true" />
    </button>
  );
}

/** A choice among a few, as a native select dressed as a row: the system's own picker on a phone. */
export function SelectRow<T extends string>({ label, hint, icon, value, options, onChange, disabled }: RowBase & { value: T; options: { value: T; label: string }[]; onChange: (next: T) => void; disabled?: boolean | undefined }) {
  return (
    <label className={["line", "line-select", disabled ? "off" : ""].join(" ")}>
      {icon ? <span className="line-icon">{icon}</span> : null}
      <Text label={label} hint={hint} />
      <span className="line-value">{options.find((o) => o.value === value)?.label ?? value}</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)} aria-label={typeof label === "string" ? label : undefined}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A fact: a label and its value. */
export function InfoRow({ label, hint, icon, children, mono }: RowBase & { children: ReactNode; mono?: boolean | undefined }) {
  return (
    <div className="line">
      {icon ? <span className="line-icon">{icon}</span> : null}
      <Text label={label} hint={hint} />
      <span className={["line-value", mono ? "mono" : ""].join(" ")}>{children}</span>
    </div>
  );
}

/** Whatever does not fit a row: a form, a chart, a list. */
export function Block({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return <div className={["line-block", className ?? ""].join(" ")}>{children}</div>;
}

export function AirMark() {
  return (
    <span className="air-mark" title="Transmits on the air">
      <AirIcon size={14} />
    </span>
  );
}
