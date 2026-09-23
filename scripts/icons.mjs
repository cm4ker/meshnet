// All platform artwork comes from the existing app icon: run `pnpm icons`.
// Tauri renders SVGs; pngjs removes the alpha channel required to be absent on iOS.
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const cli = join(dirname(require.resolve("@tauri-apps/cli/package.json")), "tauri.js");
const web = join(root, "apps/web/public");
const android = join(root, "apps/mobile/android/app/src/main/res");
const ios = join(root, "apps/mobile/ios/App/App/Assets.xcassets");
const source = await readFile(join(web, "icon.svg"), "utf8");
const mark = source.match(/<g\b[\s\S]*?<\/g>/)?.[0];
const background = source.match(/<rect\b[^>]*fill="([^"]+)"/)?.[1];
if (!mark || !background) throw new Error("icon.svg must contain its background rect and a group for the mark");
const whiteMark = mark.replace(/(stroke|fill)="#[0-9a-f]+"/gi, '$1="#ffffff"');
const svg = (body, viewBox = "0 0 64 64") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;
const solid = `<rect width="64" height="64" fill="${background}"/>`;
const scratchRoot = resolve(tmpdir());
const work = await mkdtemp(join(scratchRoot, "meshnet-icons-"));

async function put(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function copy(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}

function render(input, output, sizes = []) {
  execFileSync(process.execPath, [cli, "icon", input, "--output", output, ...sizes.flatMap(size => ["--png", String(size)])], {
    cwd: root, stdio: "inherit", windowsHide: true,
  });
}

try {
  await put(join(work, "icon.svg"), source);
  // Keep every node within Android's circular safe area, including monochrome.
  await put(join(work, "mark.svg"), svg(`<g transform="translate(8 8) scale(.75)">${mark}</g>`));
  await put(join(work, "monochrome.svg"), svg(`<g transform="translate(8 8) scale(.75)">${whiteMark}</g>`));
  await put(join(work, "white.svg"), svg(whiteMark));
  await put(join(work, "background.svg"), svg(solid));
  await put(join(work, "opaque.svg"), svg(solid + mark));
  await put(join(work, "icons.json"), JSON.stringify({
    default: "icon.svg", bg_color: background,
    android_bg: "background.svg", android_fg: "mark.svg",
    android_monochrome: "monochrome.svg",
  }));
  const native = join(work, "native");
  render(join(work, "icons.json"), native);

  for (const entry of await readdir(native, { withFileTypes: true })) {
    if (entry.isFile()) await copy(join(native, entry.name), join(root, "apps/desktop/src-tauri/icons", entry.name));
  }
  // The generated Android tree contains only icon resources, not app settings.
  for (const dir of await readdir(join(native, "android"))) {
    for (const file of await readdir(join(native, "android", dir))) {
      if (file === "ic_launcher_background.png") continue;
      await copy(join(native, "android", dir, file), join(android, dir, file));
    }
  }
  const adaptive = (await readFile(join(android, "mipmap-anydpi-v26/ic_launcher.xml"), "utf8"))
    .replace("@mipmap/ic_launcher_background", "@color/ic_launcher_background");
  await put(join(android, "mipmap-anydpi-v26/ic_launcher.xml"), adaptive);
  await put(join(android, "mipmap-anydpi-v26/ic_launcher_round.xml"), adaptive);
  await put(join(android, "values/ic_launcher_background.xml"), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${background}</color>
</resources>
`);

  const png = join(work, "png");
  render(join(work, "icon.svg"), png, [192, 512]);
  for (const size of [192, 512]) await copy(join(png, `${size}x${size}.png`), join(web, `icon-${size}.png`));
  render(join(work, "opaque.svg"), png, [180, 512, 1024]);
  await copy(join(png, "180x180.png"), join(web, "apple-touch-icon.png"));
  await copy(join(png, "512x512.png"), join(web, "icon-maskable.png"));
  const iosIcon = PNG.sync.read(await readFile(join(png, "1024x1024.png")));
  await put(join(ios, "AppIcon.appiconset/AppIcon-512@2x.png"), PNG.sync.write(iosIcon, { colorType: 2 }));
  render(join(work, "white.svg"), png, [96]);
  await copy(join(png, "96x96.png"), join(web, "notification-badge.png"));
  render(join(work, "icon.svg"), png, [480]);
  await copy(join(png, "480x480.png"), join(android, "drawable-nodpi/splash_mark.png"));

  const splash = svg('<rect width="2732" height="2732" fill="#282c33"/>' +
    `<svg x="1110" y="1110" width="512" height="512" viewBox="0 0 64 64">${source.replace(/<\/?svg[^>]*>/g, "")}</svg>`, "0 0 2732 2732");
  await put(join(work, "splash.svg"), splash);
  render(join(work, "splash.svg"), png, [2732]);
  for (const name of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
    await copy(join(png, "2732x2732.png"), join(ios, "Splash.imageset", name));
  }

  // Android's status bar needs a transparent, white drawable. Circles become
  // arc paths; each shape keeps whether it is filled or stroked.
  const attrsOf = text => Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]+)"/g)].map(([, key, value]) => [key, value]));
  const group = attrsOf(mark.match(/<g\b([^>]*)>/)[1]);
  const shapes = [...mark.matchAll(/<(circle|path)\b([^>]*)\/>/g)].map(([, type, attributes]) => {
    const attrs = { ...group, ...attrsOf(attributes) };
    const x = Number(attrs.cx), y = Number(attrs.cy), r = Number(attrs.r);
    const d = type === "path" ? attrs.d : `M${x - r},${y}a${r},${r} 0,1 0,${2 * r},0a${r},${r} 0,1 0,-${2 * r},0`;
    return attrs.fill && attrs.fill !== "none"
      ? `        <path android:pathData="${d}" android:fillColor="#FFFFFFFF" />`
      : `        <path android:pathData="${d}" android:fillColor="#00000000" android:strokeColor="#FFFFFFFF" android:strokeWidth="${attrs["stroke-width"]}" android:strokeLineCap="round" android:strokeLineJoin="round" />`;
  });
  if (!shapes.length) throw new Error("icon.svg's mark has no circles or paths");
  await put(join(android, "drawable/ic_stat_meshnet.xml"), `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated from apps/web/public/icon.svg by pnpm icons. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="44" android:viewportHeight="44">
    <group android:translateX="-10" android:translateY="-11">
${shapes.join("\n")}
    </group>
</vector>
`);
  console.log("Updated web, desktop, Android and iOS artwork from apps/web/public/icon.svg");
} finally {
  if (dirname(work) !== scratchRoot || !basename(work).startsWith("meshnet-icons-")) throw new Error("Unexpected icon scratch directory");
  await rm(work, { recursive: true, force: true });
}
