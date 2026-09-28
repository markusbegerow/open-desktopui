# Builds a native oikb sidecar binary for Windows. Run manually once to
# validate before trusting this in CI (see oikb.spec's header comment) —
# PyInstaller does not cross-compile, so build.sh (macOS/Linux) is separate.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

uv venv .build-venv
. .build-venv\Scripts\Activate.ps1
uv pip install "../../oikb-main[all]" pyinstaller

pyinstaller --clean --noconfirm oikb.spec

Write-Host "Built: $PSScriptRoot\dist\oikb.exe"
