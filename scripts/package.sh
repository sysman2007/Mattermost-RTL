#!/usr/bin/env bash
# Build the uploadable plugin bundle: dist/com.github.sysman2007.mattermost-rtl-<version>.tar.gz
# Usage: ./scripts/package.sh
# Needs node (syntax check) and Go (server binaries, version from server/go.mod).
set -euo pipefail

cd "$(dirname "$0")/.."

ID=$(sed -n 's/^  "id": *"\([^"]*\)".*/\1/p' plugin.json)
VERSION=$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' plugin.json)

node --check webapp/dist/main.js
node --check public/md-preview/frame.js

# Server binaries for the platforms listed in plugin.json.
rm -rf server/dist
for target in linux-amd64 linux-arm64; do
  (cd server && CGO_ENABLED=0 GOOS="${target%-*}" GOARCH="${target#*-}" \
    go build -trimpath -ldflags "-s -w" -o "dist/plugin-$target" .)
done

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$ID/server"
cp -r plugin.json webapp public "$STAGE/$ID/"
cp -r server/dist "$STAGE/$ID/server/"

mkdir -p dist
OUT="dist/$ID-$VERSION.tar.gz"
tar -C "$STAGE" -czf "$OUT" "$ID"

echo "Built $OUT"
