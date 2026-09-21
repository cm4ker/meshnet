# The phone shell

Capacitor 8 around the built client (`apps/web/dist`), for iOS and Android. The
shell carries the client rather than loading it from a server: a radio in a field
has no network, and the app must open without one. The only native code is the
two plugins the client calls, BLE (`@capacitor-community/bluetooth-le`) and the
secure storage that keeps node passwords.

## Android

    pnpm android         # builds the client, syncs, opens Android Studio
    pnpm --filter @meshnet/mobile android:apk

CI builds a debug APK on every push (`.github/workflows/build.yml`).

## iOS

It needs a Mac with Xcode. The Mac here is `server.lan`, the same one the Sovabox
phone app is built on, and the same Apple team (8CNDTQVA32). The build keeps its
derived data under `~/Library/Caches/meshnet-ios` and the tree under
`~/build/meshnet`.

Ship the tree from Windows, with LF line endings. `git archive` follows
`core.autocrlf` and would otherwise put a `\r` after `#!/bin/bash`:

    git add apps/mobile
    git -c core.autocrlf=false archive --format=tar $(git write-tree) |
      ssh cmaker@server.lan 'rm -rf ~/build/meshnet && mkdir -p ~/build/meshnet && tar -xf - -C ~/build/meshnet'

Then, on the Mac:

    cd ~/build/meshnet
    bash apps/mobile/scripts/ios.sh simulator

That installs the packages, builds the client, syncs it into the project, builds,
creates the simulator "Meshnet iPhone" if it is missing, installs the app and
opens it. The simulator has no Bluetooth, so the connect screen says "BLE
unsupported" there; a radio needs a phone. `xcrun simctl delete "Meshnet iPhone"`
afterwards: a simulator is about 2 GB, and that Mac's disk is short.

### TestFlight

    BUILD_NUMBER=$(git rev-list --count HEAD)     # on Windows, before shipping
    bash apps/mobile/scripts/ios.sh testflight     # on the Mac, with BUILD_NUMBER set

It registers the App ID and makes a fresh App Store profile, "Meshnet App Store",
through the App Store Connect API (`scripts/apple.mjs`). Then it archives, signed
with the team's Apple Distribution identity, and `xcodebuild -exportArchive`
uploads the build for internal testing. `ios.sh archive` stops before the upload.

What it reads is the Mac's, not the tree's: `~/.appstoreconnect/owlmail.env`
names the API key (`ASC_KEY_ID`, `ASC_ISSUER_ID`; the key itself is in
`~/.appstoreconnect/private_keys`) and the keychain holding the identity, with the
file that unlocks it. An ssh session has to unlock a keychain itself. `ASC_ENV`
names another file.

The one thing the API cannot do is create the app in App Store Connect. That is
done once, by hand, at appstoreconnect.apple.com → Apps → New App, with bundle ID
`dev.cm4ker.meshnet`. Until then `testflight` stops and says so.

The build number is the commit count on master. App Store Connect refuses a
number it has already seen, and that count only grows.

### Known and worked around

- `CapApp-SPM/Package.swift` points into `node_modules/.pnpm`, and pnpm shortens
  those directory names on Windows but not on a Mac. `cap sync` rewrites the file,
  so `ios.sh` always syncs before it builds; a sync on Windows leaves the
  shortened paths, which is what is committed.
- Bluetooth needs no capability on the App ID. The usage strings and the
  `bluetooth-central` background mode, which keeps a connection alive while
  another app is in front, are in `Info.plist`.
- `ITSAppUsesNonExemptEncryption` is false. The radio encrypts what goes on the
  air. The client only uses WebCrypto (the system's AES and SHA-256) to recognise
  its own channel messages when a repeater sends them back.
