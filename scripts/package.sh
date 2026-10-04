#!/usr/bin/env bash
# Build the uploadable plugin bundle: dist/com.ibarsam.barsam-<version>.tar.gz
# Usage: ./scripts/package.sh
set -euo pipefail

cd "$(dirname "$0")/.."

ID=$(sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' plugin.json)
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' plugin.json)

node --check webapp/dist/main.js

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$ID"
cp -r plugin.json webapp public "$STAGE/$ID/"

mkdir -p dist
OUT="dist/$ID-$VERSION.tar.gz"
tar -C "$STAGE" -czf "$OUT" "$ID"

echo "Built $OUT"
ls public/fonts
