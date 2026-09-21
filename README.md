# Meshnet

A companion client for [MeshCore](https://github.com/meshcore-dev/MeshCore) radios: chat over a LoRa mesh through a radio on Bluetooth or USB. One TypeScript client, three homes — a browser tab, a desktop window, a phone.

```
packages/meshcore   the Companion Radio Protocol and a session over it; no platform code
apps/web            the client: React + Vite; picks its link to the radio at runtime
apps/desktop        Tauri 2 shell: Windows, macOS, Linux; BLE and USB serial through plugins
apps/mobile         Capacitor 8 shell: iOS and Android; BLE through a plugin
```

## What it does

- Connects to a radio over BLE (everywhere), a USB cable (desktop, and a browser with Web Serial), or Wi-Fi (phone; companion firmware built with Wi-Fi, TCP port 5000).
- Reads the radio's contacts and channels, and drains its message queue; keeps history on the device, per radio, in IndexedDB. The radio only ever holds what has not been read.
- Direct messages with delivery: sent, acknowledged (with the round trip), unconfirmed with a retry, failed. A message that went unacknowledged along a learned route is retried as a flood.
- Routes you can steer: a contact pinned to flood (handy on the move), and a time limit after which a learned route is dropped so the next message floods and finds a fresh one; a default for every chat and room, and one per contact.
- Channel messages, with the sender's name split off the `Name: text` the firmware puts on the air.
- Tap a message for how it travelled: the relays of its route, named from the contacts where a hash is unambiguous; every copy the radio heard, with its signal; for ours, who relayed it, or the route a flood's acknowledgement brought back.
- Cyrillic letters that look exactly like Latin ones (а е о р с х, А В Е К М Н О Р С Т Х) go out as their one-byte Latin twins, so about a fifth more Russian fits in a message and reads the same.
- Contacts: favourites, rename, forget route, path discovery, share on air, telemetry (Cayenne LPP decoded), remove.
- A map of every node that advertises a position, and this radio: markers by kind, faded as their last advert ages; pick one for its distance and bearing, and the route the radio holds to it drawn through the relays whose position is known. OpenStreetMap tiles, kept on the device as they are seen so the map still draws where there is no network. On a phone the map takes the Log's place in the tab bar; the log opens from Radio.
- Nodes: the repeaters, rooms and sensors you manage, remotely through your radio. Sign in (the password kept in the system's credential store on the desktop, the phone's secure storage on a phone, the browser's storage in a browser); status with a week's trend of battery and noise floor; the neighbours a repeater hears; its settings as forms over its console, with a timed trial before a radio change; who may sign in, and as what; the console itself; a sensor's min, max and mean over a window. The radio carries one request to a remote node at a time, so they queue, visibly, and nothing asks the air on its own.
- The radio's own settings: name, position, frequency/bandwidth/SF/CR with presets, transmit power, channels (name and 128-bit key), auto-add and telemetry policy, tuning, clock, adverts (zero-hop or flood), reboot, factory reset.
- A log of pushes and, when asked, every frame in hex.
- A demo radio (`?demo` in a browser, or any development build) for a look around with no hardware.

## Running it

```
pnpm install
pnpm test          # protocol, client and session tests, no hardware needed
pnpm web           # the client at http://localhost:5180 — Chrome or Edge for Web Bluetooth / Web Serial
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

`CAP_SERVER_URL=http://<your-lan-ip>:5180 pnpm mobile:sync` points a development build at a running `pnpm web` instead of the bundled client.

## Builds

Every push to `master` runs the checks and builds the Windows installers (x64 and ARM64), a debug Android APK and the web bundle. They land on the rolling `dev` pre-release under Releases, replaced each time; a `v*` tag makes a proper release from the same workflow. Pull requests get the same builds as workflow artifacts. iOS is not built there: it is built on a Mac and uploaded to TestFlight by hand, see [apps/mobile/README.md](apps/mobile/README.md).

## Where the protocol came from

Every opcode and layout in `packages/meshcore/src/protocol` is copied from the firmware's `examples/companion_radio/MyMesh.cpp` (v1.17.1, protocol version 13). The client announces protocol version 3 to the radio, which is where the message frames gained an SNR byte; nothing above it changes what the firmware sends. Frames this client does not know are reported, never thrown on.

Serial framing is `'<'`/`'>'`, a little-endian length and the payload; BLE is one frame per write or notification on the Nordic UART service.

## Bluetooth notes

- The firmware's UART characteristics demand an encrypted, PIN-paired link. On Windows the shell pairs by itself: pick the radio, and when it asks, type the PIN from the radio's screen (or its configured one). A bond the radio no longer honours (it was re-flashed, or reset) shows up the same way and is replaced.
- Windows talks to the radio through its own GATT API (`winble.rs`), not btleplug: once bonded, asking the radio itself for the characteristics of the encrypted service never returns on this stack, while Windows' cache of them, filled at pairing, answers at once. The shell asks the cache first.
- USB on an nRF52 companion (T-Echo, RAK4631, Heltec T114) is only a link if the firmware is the `_usb` build; the `_ble` build's serial port is silent.
- Android: the BLE plugin asks for a 512-byte MTU on connect; the firmware's frames are up to 176 bytes. The phone's own pairing prompt handles the PIN.
- iOS: `bluetooth-central` is in the background modes so a connection outlives a switch to another app.
