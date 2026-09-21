import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}

export function Select({ children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select className="input select" {...rest}>
      {children}
    </select>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (next: boolean) => void; hint?: ReactNode }) {
  return (
    <label className="toggle">
      <span className="toggle-text">
        <span>{label}</span>
        {hint ? <span className="field-hint">{hint}</span> : null}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** A row in a settings section: a label on the left, the value or control on the right. */
export function Row({ label, children, onClick }: { label: ReactNode; children?: ReactNode; onClick?: (() => void) | undefined }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag className={["kv", onClick ? "kv-action" : ""].join(" ")} type={onClick ? "button" : undefined} onClick={onClick}>
      <span className="kv-label">{label}</span>
      <span className="kv-value">{children}</span>
    </Tag>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head">
        <h2>{title}</h2>
        {actions ? <span className="section-actions">{actions}</span> : null}
      </header>
      <div className="section-body">{children}</div>
    </section>
  );
}
