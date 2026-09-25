/**
 * The Android phone's status bar and buttons sit over the page (MainActivity
 * draws it edge to edge), so their icons take the page's theme rather than the
 * phone's: a dark theme on a phone set to light would otherwise have dark
 * icons on a dark page.
 */

import { nativePlatform } from "./platform.js";

type Appearance = "light" | "dark";

let last: Appearance | null = null;

export function paintSystemBars(appearance: Appearance): void {
  if (nativePlatform() !== "android" || appearance === last) return;
  last = appearance;
  void import("@capacitor/core")
    .then(({ SystemBars, SystemBarsStyle }) =>
      // DARK is the style for a dark page: light icons.
      SystemBars.setStyle({ style: appearance === "dark" ? SystemBarsStyle.Dark : SystemBarsStyle.Light }),
    )
    .catch(() => undefined);
}
