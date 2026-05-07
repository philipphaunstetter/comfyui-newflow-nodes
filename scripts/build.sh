#!/usr/bin/env bash
# Build a distributable ZIP of comfyui-newflow-nodes.
# Output: dist/comfyui-newflow-nodes-<version>.zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PKG_NAME="comfyui-newflow-nodes"

VERSION="$(grep -E '^version\s*=' pyproject.toml | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
if [[ -z "${VERSION}" ]]; then
    echo "ERROR: could not read version from pyproject.toml" >&2
    exit 1
fi

DIST_DIR="$ROOT/dist"
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

OUT_NAME="${PKG_NAME}-${VERSION}.zip"
OUT_PATH="${DIST_DIR}/${OUT_NAME}"

mkdir -p "$DIST_DIR"
rm -f "$OUT_PATH"

echo "Staging ${PKG_NAME} v${VERSION}..."

rsync -a \
    --exclude='.git/' \
    --exclude='.gitignore' \
    --exclude='__pycache__/' \
    --exclude='*.pyc' \
    --exclude='.DS_Store' \
    --exclude='.venv/' \
    --exclude='.idea/' \
    --exclude='.vscode/' \
    --exclude='dist/' \
    --exclude='build/' \
    --exclude='scripts/' \
    --exclude='CLAUDE.md' \
    "$ROOT/" "$STAGE_DIR/$PKG_NAME/"

echo "Zipping..."
( cd "$STAGE_DIR" && zip -qr "$OUT_PATH" "$PKG_NAME" )

SIZE="$(du -h "$OUT_PATH" | cut -f1)"
echo ""
echo "Built ${OUT_NAME} (${SIZE})"
echo "  -> $OUT_PATH"
echo ""
echo "Install instructions:"
echo "  1. Unzip into ComfyUI/custom_nodes/"
echo "  2. (If requirements.txt is non-empty) pip install -r ComfyUI/custom_nodes/${PKG_NAME}/requirements.txt"
echo "  3. Restart ComfyUI"
