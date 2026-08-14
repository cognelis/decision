#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
source_svg="$project_root/apps/desktop/assets/decision-mark.svg"
assets_dir="$project_root/apps/desktop/assets"

for required_command in qlmanage sips iconutil; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required icon tool: $required_command" >&2
    exit 1
  fi
done

if [ ! -f "$source_svg" ]; then
  echo "Missing icon source: $source_svg" >&2
  exit 1
fi

icon_work_dir=$(mktemp -d "${TMPDIR:-/tmp}/decision-icons.XXXXXX")
cleanup() {
  rm -rf -- "$icon_work_dir"
}
trap cleanup EXIT INT TERM

app_png="$icon_work_dir/app-1024.png"
mono_png="$icon_work_dir/template-1024.png"
iconset="$icon_work_dir/app-icon.iconset"
electron_bin="$project_root/node_modules/.bin/electron"
mkdir -p "$iconset"

if [ ! -x "$electron_bin" ]; then
  echo "Missing Electron runtime: run npm install first" >&2
  exit 1
fi

"$electron_bin" \
  "$project_root/scripts/render-icon-svg.cjs" \
  "$source_svg" \
  "$mono_png"

render_dir="$icon_work_dir/render-app"
mkdir -p "$render_dir"
qlmanage -t -s 1024 -o "$render_dir" "$source_svg" >/dev/null
mv "$render_dir/$(basename "$source_svg").png" "$app_png"

if [ ! -f "$mono_png" ] || [ ! -f "$app_png" ]; then
  echo "Icon renderer did not produce the required PNG files" >&2
  exit 1
fi

make_png() {
  input=$1
  size=$2
  output=$3
  sips -z "$size" "$size" "$input" --out "$output" >/dev/null
}

make_png "$mono_png" 16 "$assets_dir/trayTemplate.png"
make_png "$mono_png" 32 "$assets_dir/trayTemplate@2x.png"
sips \
  --setProperty dpiWidth 144 \
  --setProperty dpiHeight 144 \
  "$assets_dir/trayTemplate@2x.png" >/dev/null

make_png "$app_png" 16 "$iconset/icon_16x16.png"
make_png "$app_png" 32 "$iconset/icon_16x16@2x.png"
make_png "$app_png" 32 "$iconset/icon_32x32.png"
make_png "$app_png" 64 "$iconset/icon_32x32@2x.png"
make_png "$app_png" 128 "$iconset/icon_128x128.png"
make_png "$app_png" 256 "$iconset/icon_128x128@2x.png"
make_png "$app_png" 256 "$iconset/icon_256x256.png"
make_png "$app_png" 512 "$iconset/icon_256x256@2x.png"
make_png "$app_png" 512 "$iconset/icon_512x512.png"
make_png "$app_png" 1024 "$iconset/icon_512x512@2x.png"

iconutil -c icns "$iconset" -o "$assets_dir/app-icon.icns"
