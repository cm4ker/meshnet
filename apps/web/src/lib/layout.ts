import { useSyncExternalStore } from "react";

/** Wide enough for the list and the reader side by side. */
const WIDE = "(min-width: 840px)";

export function isWide(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(WIDE).matches;
}

export function useWide(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const media = window.matchMedia(WIDE);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    },
    isWide,
  );
}
