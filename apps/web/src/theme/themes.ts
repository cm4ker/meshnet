/**
 * The palettes are Zed's One Dark and One Light, and so is the surface
 * hierarchy: in a dark theme the chrome is the lightest surface and the
 * reading surface the darkest.
 */

export type ThemeToken =
  | "bg"
  | "panel"
  | "chrome"
  | "elevated"
  | "hover"
  | "selected"
  | "border"
  | "borderStrong"
  | "text"
  | "textMuted"
  | "textFaint"
  | "accent"
  | "accentContrast"
  | "danger"
  | "warning"
  | "success"
  | "bubbleOut"
  | "bubbleIn";

export type ThemeTokens = Record<ThemeToken, string>;

export interface Theme {
  id: string;
  name: string;
  appearance: "light" | "dark";
  tokens: ThemeTokens;
}

export const themes: Theme[] = [
  {
    id: "one-dark",
    name: "One Dark",
    appearance: "dark",
    tokens: {
      bg: "#282c33",
      panel: "#2f343e",
      chrome: "#3b414d",
      elevated: "#2f343e",
      hover: "#363c46",
      selected: "#454a56",
      border: "#363c46",
      borderStrong: "#464b57",
      text: "#dce0e5",
      textMuted: "#a9afbc",
      textFaint: "#878a98",
      accent: "#74ade8",
      accentContrast: "#282c33",
      danger: "#d07277",
      warning: "#dec184",
      success: "#a1c181",
      bubbleOut: "#3a4a63",
      bubbleIn: "#353a44",
    },
  },
  {
    id: "one-light",
    name: "One Light",
    appearance: "light",
    tokens: {
      bg: "#fafafa",
      panel: "#ebebec",
      chrome: "#dcdcdd",
      elevated: "#fafafa",
      hover: "#dfdfe0",
      selected: "#cacaca",
      border: "#dfdfe0",
      borderStrong: "#c9c9ca",
      text: "#242529",
      textMuted: "#5c5e63",
      textFaint: "#8a8c91",
      accent: "#5c78e2",
      accentContrast: "#fafafa",
      danger: "#d36151",
      warning: "#b48f2c",
      success: "#659f58",
      bubbleOut: "#dfe6f7",
      bubbleIn: "#ececed",
    },
  },
];

export const defaultDark = themes[0]!;
export const defaultLight = themes[1]!;

export function findTheme(id: string): Theme | undefined {
  return themes.find((t) => t.id === id);
}

export function cssVariable(token: ThemeToken): string {
  return `--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}
