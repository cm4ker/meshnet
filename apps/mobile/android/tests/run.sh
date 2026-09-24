#!/usr/bin/env bash
# The native checks that need no radio and no Gradle, with a JDK 17 or later:
#   bash apps/mobile/android/tests/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
javac -d "$out" "$here/../app/src/main/java/dev/cm4ker/meshnet/RelayMux.java" "$here/relay-mux/RelayMuxCheck.java"
java -cp "$out" dev.cm4ker.meshnet.RelayMuxCheck
