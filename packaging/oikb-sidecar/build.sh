#!/usr/bin/env bash
# Builds a native oikb sidecar binary for the current OS/arch (macOS/Linux —
# see build.ps1 for Windows). Run manually once to validate before trusting
# this in CI (see oikb.spec's header comment); PyInstaller does not
# cross-compile, so this must run natively on each target platform.
set -euo pipefail
cd "$(dirname "$0")"

VENV_DIR=".build-venv"
uv venv "$VENV_DIR"
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
uv pip install "../../oikb-main[all]" pyinstaller

pyinstaller --clean --noconfirm oikb.spec

echo "Built: $(pwd)/dist/oikb"
