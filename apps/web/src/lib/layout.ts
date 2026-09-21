import { useSyncExternalStore } from "react";

/** Wide enough for the list and the reader side by side. */
const WIDE = "(min-width: 840px)";

export function useWide(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const media = window.matchMedia(WIDE);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    },
    () => window.matchMedia(WIDE).matches,
  );
}
