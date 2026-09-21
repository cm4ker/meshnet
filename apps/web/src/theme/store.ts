import { cssVariable, defaultDark, defaultLight, findTheme, themes, type Theme, type ThemeToken } from "./themes.js";

const KEY = "meshnet.theme";
/** The chosen theme's ground, for the boot screen `index.html` paints before this runs. */
const GROUND_KEY = "meshnet.theme.ground";

/** A theme id, or `"system"` to follow the OS. */
export type ThemePreference = string;

const listeners = new Set<() => void>();
let preference: ThemePreference = read();
let media: MediaQueryList | null = null;

function read(): ThemePreference {
  try {
    return localStorage.getItem(KEY) ?? "system";
  } catch {
    return "system";
  }
}

function prefersDark(): boolean {
  return media?.matches ?? false;
}

export function getPreference(): ThemePreference {
  return preference;
}

export function getActiveTheme(): Theme {
  if (preference === "system") return prefersDark() ? defaultDark : defaultLight;
  return findTheme(preference) ?? defaultDark;
}

export function listThemes(): Theme[] {
  return themes;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setPreference(next: ThemePreference): void {
  preference = next;
  try {
    localStorage.setItem(KEY, next);
    if (next === "system") localStorage.removeItem(GROUND_KEY);
    else localStorage.setItem(GROUND_KEY, getActiveTheme().tokens.bg);
  } catch {
    // Private window.
  }
  apply();
}

function apply(): void {
  const theme = getActiveTheme();
  const root = document.documentElement;
  for (const token of Object.keys(theme.tokens) as ThemeToken[]) {
    root.style.setProperty(cssVariable(token), theme.tokens[token]);
  }
  root.style.colorScheme = theme.appearance;
  root.dataset["appearance"] = theme.appearance;
  for (const listener of listeners) listener();
}

/** Before the first render, so the page never paints in one palette and resolves into another. */
export function initTheme(): void {
  media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => {
    if (preference === "system") apply();
  });
  apply();
}
