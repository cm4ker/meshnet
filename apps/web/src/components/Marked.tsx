import type { ReactNode } from "react";
import { matchRanges } from "../lib/messageSearch.js";

/** A text with each place a search query stands in it marked; the text as it is without one. */
export function marked(text: string, query: string | undefined): ReactNode {
  const ranges = query ? matchRanges(text, query) : [];
  if (ranges.length === 0) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) out.push(text.slice(at, start));
    out.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
