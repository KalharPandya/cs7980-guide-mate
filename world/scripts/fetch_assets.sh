#!/usr/bin/env bash
# Fetch CC0 3D assets for the virtual world guide fleet Three.js scene.
#
# Downloads (all CC0 / public domain):
#   1. robot.glb      - three.js "RobotExpressive" sample model (Don McCurdy, CC0)
#   2. furniture/*.glb - Kenney Furniture Kit, GLB models only (Kenney, CC0)
#   3. visitor.glb    - Quaternius human model via poly.pizza (Quaternius, CC0)
#
# Safe to re-run: every step is skip-if-exists, so a second run is a no-op.
#
# Usage: world/scripts/fetch_assets.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

MODELS_DIR="$REPO_ROOT/world-client/public/models"
TEXTURES_DIR="$REPO_ROOT/world-client/public/textures"
FURNITURE_DIR="$MODELS_DIR/furniture"

ROBOT_URL="https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/RobotExpressive/RobotExpressive.glb"
KENNEY_PAGE_URL="https://kenney.nl/assets/furniture-kit"
VISITOR_PAGE_URL="https://poly.pizza/m/c3Ibh9I3udk"
VISITOR_DIRECT_URL="https://static.poly.pizza/170235d2-cdeb-4cb2-a82f-4828585138fe.glb"

log() {
    echo "[fetch_assets] $*"
}

err() {
    echo "[fetch_assets] ERROR: $*" >&2
}

# Temp files/dirs registered here are removed on any exit (success, error, or
# early `exit`). Top-level `trap ... RETURN` does not fire for a script (only
# for functions/sourced files), so we use EXIT with an accumulating list.
TMP_PATHS=()
cleanup_tmp() {
    local exit_code=$?
    local p
    for p in "${TMP_PATHS[@]:-}"; do
        [ -n "$p" ] && rm -rf "$p"
    done
    # An EXIT trap's own last command determines the shell's final exit
    # status when the script never calls `exit` explicitly (e.g. the
    # `[ -n "$p" ]` test above returning 1 on an empty TMP_PATHS would
    # otherwise silently turn a successful run into exit code 1).
    return "$exit_code"
}
trap cleanup_tmp EXIT

# Returns 0 if the file exists, is non-empty, and its first 4 bytes are the
# glTF binary magic ("glTF" / 0x67 0x6c 0x54 0x46). Checks real bytes, not
# just HTTP status or file size.
is_valid_glb() {
    local f="$1"
    [ -s "$f" ] || return 1
    local magic
    magic="$(head -c 4 -- "$f" 2>/dev/null || true)"
    [ "$magic" = "glTF" ]
}

download_to() {
    local url="$1" dest="$2"
    log "GET $url"
    rm -f "${dest}.part"
    curl -fL --retry 3 --retry-delay 2 -o "${dest}.part" "$url"
    mv "${dest}.part" "$dest"
}

mkdir -p "$MODELS_DIR" "$TEXTURES_DIR" "$FURNITURE_DIR"

# --- 1. Robot model -----------------------------------------------------
ROBOT_DEST="$MODELS_DIR/robot.glb"
if is_valid_glb "$ROBOT_DEST"; then
    log "robot.glb already present and valid, skipping"
else
    rm -f "$ROBOT_DEST"
    download_to "$ROBOT_URL" "$ROBOT_DEST"
    if ! is_valid_glb "$ROBOT_DEST"; then
        err "downloaded robot.glb does not start with glTF magic bytes"
        exit 1
    fi
    log "robot.glb OK ($(wc -c < "$ROBOT_DEST") bytes)"
fi

# --- 2. Kenney Furniture Kit (CC0) --------------------------------------
furniture_present() {
    [ -f "$FURNITURE_DIR/LICENSE.txt" ] || return 1
    find "$FURNITURE_DIR" -maxdepth 1 -iname '*.glb' -print -quit | grep -q .
}

if furniture_present; then
    log "furniture kit already present, skipping"
else
    PAGE_HTML="$(mktemp)"
    ZIP_TMP="$(mktemp --suffix=.zip)"
    EXTRACT_TMP="$(mktemp -d)"
    TMP_PATHS+=("$PAGE_HTML" "$ZIP_TMP" "$EXTRACT_TMP")

    log "GET $KENNEY_PAGE_URL (to resolve the versioned zip URL)"
    curl -fsSL "$KENNEY_PAGE_URL" -o "$PAGE_HTML"

    ZIP_URL="$(grep -oE "https://kenney\.nl/[^'\"]+\.zip" "$PAGE_HTML" | head -1 || true)"
    if [ -z "$ZIP_URL" ]; then
        err "could not find a .zip href on $KENNEY_PAGE_URL"
        exit 1
    fi
    log "resolved zip URL: $ZIP_URL"

    download_to "$ZIP_URL" "$ZIP_TMP"
    log "unzipping furniture kit"
    unzip -q "$ZIP_TMP" -d "$EXTRACT_TMP"

    LICENSE_SRC="$(find "$EXTRACT_TMP" -maxdepth 1 -iname 'license.txt' -print -quit || true)"
    if [ -z "$LICENSE_SRC" ]; then
        err "no License.txt found in Kenney furniture kit zip"
        exit 1
    fi
    if ! grep -qi 'CC0' "$LICENSE_SRC"; then
        err "License.txt in Kenney zip does not mention CC0 - refusing to proceed"
        exit 1
    fi

    mkdir -p "$FURNITURE_DIR"
    # Keep only the .glb models (drop FBX/OBJ/DAE/STL/MTL/preview PNGs to save repo space).
    glb_count=0
    while IFS= read -r -d '' f; do
        cp "$f" "$FURNITURE_DIR/"
        glb_count=$((glb_count + 1))
    done < <(find "$EXTRACT_TMP" -iname '*.glb' -print0)

    if [ "$glb_count" -eq 0 ]; then
        err "no .glb files found inside the Kenney furniture kit zip"
        exit 1
    fi

    cp "$LICENSE_SRC" "$FURNITURE_DIR/LICENSE.txt"

    log "furniture kit OK ($glb_count .glb files)"
fi

# --- 3. Visitor human model (Quaternius via poly.pizza, CC0) ------------
VISITOR_DEST="$MODELS_DIR/visitor.glb"
if is_valid_glb "$VISITOR_DEST"; then
    log "visitor.glb already present and valid, skipping"
else
    rm -f "$VISITOR_DEST"
    if curl -fsSL --retry 3 --retry-delay 2 -o "${VISITOR_DEST}.part" "$VISITOR_DIRECT_URL"; then
        mv "${VISITOR_DEST}.part" "$VISITOR_DEST"
    else
        log "direct poly.pizza URL failed, falling back to scraping $VISITOR_PAGE_URL"
        rm -f "${VISITOR_DEST}.part"
        PAGE_HTML="$(mktemp)"
        TMP_PATHS+=("$PAGE_HTML")
        curl -fsSL "$VISITOR_PAGE_URL" -o "$PAGE_HTML"
        FALLBACK_URL="$(grep -oE "https://static\.poly\.pizza/[A-Za-z0-9-]+\.glb" "$PAGE_HTML" | head -1 || true)"
        if [ -z "$FALLBACK_URL" ]; then
            err "could not resolve a static.poly.pizza GLB URL from $VISITOR_PAGE_URL"
            exit 1
        fi
        log "resolved fallback visitor URL: $FALLBACK_URL"
        download_to "$FALLBACK_URL" "$VISITOR_DEST"
    fi

    if ! is_valid_glb "$VISITOR_DEST"; then
        err "downloaded visitor.glb does not start with glTF magic bytes"
        exit 1
    fi
    log "visitor.glb OK ($(wc -c < "$VISITOR_DEST") bytes)"
fi

log "all assets present at $MODELS_DIR"
