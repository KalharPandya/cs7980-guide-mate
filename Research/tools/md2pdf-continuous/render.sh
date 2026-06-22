#!/usr/bin/env bash
# Render a markdown file to a single continuous PDF page (no pagination, no
# page-break gaps) using solworktech/md2pdf as the engine.
#
# Usage:  ./render.sh <input.md> <output.pdf> [width_pt] [bottom_margin_pt]
#
# Method: a tiny patch lets md2pdf accept a custom WxH page; the Go wrapper
# (main.go) renders onto one very tall page with gofpdf auto page break off,
# measures the content height, then re-renders at exactly that height.
#
# Requires: go (1.24+) and git. Network access on first run to fetch md2pdf.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IN="${1:?usage: render.sh input.md output.pdf [width] [bottom]}"
OUT="${2:?usage: render.sh input.md output.pdf [width] [bottom]}"
WIDTH="${3:-595.28}"
BOTTOM="${4:-36}"

COMMIT="$(cat "$HERE/UPSTREAM_COMMIT")"
CACHE="${MD2PDF_CACHE:-$HOME/.cache/md2pdf-continuous}"
SRC="$CACHE/md2pdf-src-$COMMIT"
BUILD="$CACHE/build"

mkdir -p "$CACHE"

# Fetch the exact pinned upstream commit and apply the custom-size patch once.
if [ ! -d "$SRC" ]; then
  echo "Fetching md2pdf @ $COMMIT ..."
  git init -q "$SRC"
  git -C "$SRC" remote add origin https://github.com/solworktech/md2pdf.git
  git -C "$SRC" fetch -q --depth 1 origin "$COMMIT"
  git -C "$SRC" checkout -q FETCH_HEAD
  git -C "$SRC" apply "$HERE/md2pdf-customsize.patch"
  echo "Patched."
fi

mkdir -p "$BUILD"
cp "$HERE/main.go" "$BUILD/main.go"
cat > "$BUILD/go.mod" <<EOF
module mdcont

go 1.24

require github.com/solworktech/md2pdf/v2 v2.0.0

replace github.com/solworktech/md2pdf/v2 => $SRC
EOF

( cd "$BUILD" && go mod tidy >/dev/null 2>&1 && go run . -i "$IN" -o "$OUT" -w "$WIDTH" -bottom "$BOTTOM" )
