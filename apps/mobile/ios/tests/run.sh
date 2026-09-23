#!/usr/bin/env bash
# The native checks that need no radio and no Xcode project, on a Mac:
#   bash apps/mobile/ios/tests/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
swiftc -o "$out/relay-mux" "$here/../App/App/MeshRelayMux.swift" "$here/relay-mux/main.swift"
"$out/relay-mux"
