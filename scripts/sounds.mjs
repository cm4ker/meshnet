/**
 * Renders the notification signals (`sound-synth.mjs`) into every place a
 * shell reads them from: the web client's public folder (the page, the
 * desktop shell, and iOS, which copies them into Library/Sounds) and
 * Android's raw resources (a notification channel's sound). One file per
 * signal, named `signal_<id>.wav`, which is a valid Android resource name.
 * Run `pnpm sounds` after tuning one.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOUNDS, render, wav } from "./sound-synth.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const [id, sound] of Object.entries(SOUNDS)) {
  const bytes = wav(render(sound));
  for (const folder of ["apps/web/public/sounds", "apps/mobile/android/app/src/main/res/raw"]) {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, `signal_${id}.wav`), bytes);
  }
  console.log(`signal_${id}.wav: ${bytes.length} bytes`);
}
