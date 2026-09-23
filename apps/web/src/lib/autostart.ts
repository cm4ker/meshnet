/**
 * Starting the desktop app with the computer, through the shell's autostart
 * plugin: a Run key on Windows, a login item on macOS, an autostart entry on
 * Linux. The shell starts minimised when launched that way (lib.rs). Nothing
 * of it exists in a browser or on a phone.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./platform.js";

export function hasAutostart(): boolean {
  return isTauri();
}

/** What the switch is called on this system. */
export function autostartLabel(): string {
  return /Windows/i.test(navigator.userAgent) ? "Start with Windows" : "Start at login";
}

export function autostartEnabled(): Promise<boolean> {
  return invoke<boolean>("plugin:autostart|is_enabled");
}

export async function setAutostart(on: boolean): Promise<void> {
  await invoke(on ? "plugin:autostart|enable" : "plugin:autostart|disable");
}
