import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "default" | "primary" | "danger" | "ghost";

export function Button({
  variant = "default",
  size,
  busy = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "lg"; busy?: boolean; children: ReactNode }) {
  const classes = ["button", variant !== "default" ? variant : "", size ?? "", busy ? "busy" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={classes} disabled={disabled || busy} {...rest}>
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button type="button" className={["icon-button", className ?? ""].join(" ")} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}
