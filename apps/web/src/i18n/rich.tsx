import { Fragment, type ReactNode } from "react";
import { template, type Key } from "./index.js";

/**
 * A key's text with elements in its placeholders, for words that wrap a link,
 * a name in bold or a button: `tx("chats.mentioned", { name: <b>{who}</b> })`.
 * The translation decides where each one goes.
 */
export function tx(key: Key, params: Record<string, ReactNode> & { count?: number }): ReactNode {
  const parts = template(key, params.count).split(/\{(\w+)\}/);
  return parts.map((part, i) => (i % 2 === 0 ? part : <Fragment key={i}>{part in params ? params[part] : `{${part}}`}</Fragment>));
}
