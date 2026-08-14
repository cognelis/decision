#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_file="$repository_root/native/foundation-model-helper/main.swift"
output_directory="$repository_root/dist/semantic"
output_file="$output_directory/decision-foundation-model-helper"
legacy_output_file="$output_directory/decision-island-foundation-model-helper"
manifest_file="$repository_root/apps/desktop/assets/models/qwen3.5-2b-q4-k-m.json"
module_cache="${TMPDIR:-/private/tmp}/decision-swift-module-cache"

mkdir -p "$output_directory" "$module_cache"
rm -f "$legacy_output_file"

xcrun swiftc \
  -parse-as-library \
  -target arm64-apple-macosx26.0 \
  -module-cache-path "$module_cache" \
  -O \
  "$source_file" \
  -o "$output_file"

cp "$manifest_file" "$output_directory/qwen3.5-2b-q4-k-m.json"
