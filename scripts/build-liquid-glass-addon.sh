#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_file="$repository_root/native/liquid-glass/addon.mm"
output_directory="$repository_root/dist/native"
output_file="$output_directory/decision-liquid-glass.node"
legacy_output_file="$output_directory/decision-island-liquid-glass.node"

mkdir -p "$output_directory"
rm -f "$legacy_output_file"

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

node_include=$(
  node -p \
    "require('node:path').resolve(process.execPath, '../../include/node')"
)

xcrun --sdk macosx clang++ \
  -std=c++20 \
  -fobjc-arc \
  -ObjC++ \
  -bundle \
  -undefined dynamic_lookup \
  -mmacosx-version-min=13.5 \
  -I"$node_include" \
  -framework AppKit \
  -framework QuartzCore \
  "$source_file" \
  -o "$output_file"
