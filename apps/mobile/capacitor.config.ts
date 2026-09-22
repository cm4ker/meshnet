import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The phone shell carries the built client (`apps/web/dist`), unlike a mail
 * client that has a server to load its pages from: a radio in a field has no
 * network, and the app must open without one.
 *
 * `CAP_SERVER_URL` points a development build at a running `pnpm web` on the
 * LAN instead, so a change is on the phone on save.
 */
const config: CapacitorConfig = {
  appId: "dev.cm4ker.meshnet",
  appName: "Ommesh",
  webDir: "../web/dist",
  backgroundColor: "#282c33",
  // OpenStreetMap's tile policy asks every client to say who it is; the map's tiles go out with this.
  appendUserAgent: "Ommesh (+https://github.com/cm4ker/meshnet)",
  ios: {
    // The client lays itself out under the notch with `env(safe-area-inset-*)`; an inset here would count it twice.
    contentInset: "never",
    allowsLinkPreview: false,
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: Boolean(process.env["CAP_SERVER_URL"]),
  },
  plugins: {
    BluetoothLe: {
      displayStrings: {
        scanning: "Looking for radios",
        cancel: "Cancel",
        availableDevices: "Radios",
        noDeviceFound: "No radio found",
      },
    },
  },
  ...(process.env["CAP_SERVER_URL"] ? { server: { url: process.env["CAP_SERVER_URL"], cleartext: true } } : {}),
};

export default config;
