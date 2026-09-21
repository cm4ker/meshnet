# Meshnet

A companion client for [MeshCore](https://github.com/meshcore-dev/MeshCore) radios: chat over a LoRa mesh through a radio on Bluetooth or USB. One TypeScript client, three homes — a browser tab, a desktop window, a phone.

```
packages/meshcore   the Companion Radio Protocol and a session over it; no platform code
apps/web            the client: React + Vite; picks its link to the radio at runtime
apps/desktop        Tauri 2 shell: Windows, macOS, Linux; BLE and USB serial through plugins
apps/mobile         Capacitor 8 shell: iOS and Android; BLE through a plugin
```

## What it does

- Connects to a radio over BLE (everywhere) or a USB cable (desktop, and a browser with Web Serial).
- Reads the radio's contacts and channels, and drains its message queue; keeps history on the device, per radio, in IndexedDB. The radio only ever holds what has not been read.
- Direct messages with delivery: sent, acknowledged (with the round trip), unconfirmed with a retry, failed.
- Channel messages, with the sender's name split off the `Name: text` the firmware puts on the air.
- Contacts: favourites, rename, forget route, path discovery, share on air, telemetry (Cayenne LPP decoded), remove.
- Repeaters and rooms: sign in, sign out, request status (the repeater's stats decoded).
- The radio's own settings: name, position, frequency/bandwidth/SF/CR with presets, transmit power, channels (name and 128-bit key), auto-add and telemetry policy, tuning, clock, adverts (zero-hop or flood), reboot, factory reset.
- A log of pushes and, when asked, every frame in hex.
- A demo radio (`?demo` in a browser, or any development build) for a look around with no hardware.

## Running it

```
pnpm install
pnpm test          # protocol, client and session tests, no hardware needed
pnpm web           # the client at http://localhost:5173 — Chrome or Edge for Web Bluetooth / Web Serial
```

Desktop (needs a Rust toolchain):

```
pnpm desktop         # a window on the dev server
pnpm desktop:bundle  # an installer under apps/desktop/src-tauri/target/release/bundle
```

Phone:

```
pnpm android         # builds the client, syncs it into apps/mobile/android, opens Android Studio
pnpm ios             # the same for Xcode; needs a Mac
```

`CAP_SERVER_URL=http://<your-lan-ip>:5173 pnpm mobile:sync` points a development build at a running `pnpm web` instead of the bundled client.

## Where the protocol came from

Every opcode and layout in `packages/meshcore/src/protocol` is copied from the firmware's `examples/companion_radio/MyMesh.cpp` (v1.17.1, protocol version 13). The client announces protocol version 3 to the radio, which is where the message frames gained an SNR byte; nothing above it changes what the firmware sends. Frames this client does not know are reported, never thrown on.

Serial framing is `'<'`/`'>'`, a little-endian length and the payload; BLE is one frame per write or notification on the Nordic UART service.

## Bluetooth notes

- Windows: pair the radio in Settings → Bluetooth first if it has a PIN; the shell connects to what Windows already knows. A stale bond (re-paired with a phone since) shows as a connection that opens and answers nothing — remove the device and pair again.
- Android: the BLE plugin asks for a 512-byte MTU on connect; the firmware's frames are up to 176 bytes.
- iOS: `bluetooth-central` is in the background modes so a connection outlives a switch to another app.
