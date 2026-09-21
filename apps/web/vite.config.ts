import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * `base: "./"` because the same build is opened three ways — from a web
 * server, from `tauri://localhost`, and from `capacitor://localhost` — and a
 * root-relative asset path is only right for the first.
 *
 * The dev server is reachable on the LAN so a phone shell can be pointed at
 * it during development (`CAP_SERVER_URL`), and its port is what the Tauri
 * config's `devUrl` names.
 */
export default defineConfig({
  plugins: [react()],
  base: "./",
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(process.env["npm_package_version"] ?? "0.0.0"),
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
  server: {
    port: 5173,
    strictPort: true,
    host: true,
  },
});
