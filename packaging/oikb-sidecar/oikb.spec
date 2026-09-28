# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for bundling oikb (vendored unmodified in oikb-main/) as a
# real sidecar binary, so a packaged Open DesktopUI build doesn't require the
# end user to have Python/uv installed. Never edit oikb-main/ to make this
# work — this spec lives entirely in packaging/, outside the vendored tree.
#
# Build once per target OS via build.sh (macOS/Linux) or build.ps1 (Windows)
# in this same directory — PyInstaller does not cross-compile. Both scripts
# install oikb with its `all` extras (we don't know ahead of time which of
# its 46 source connectors a given user will configure) into a throwaway venv
# first.
#
# Run this once manually and confirm the resulting binary actually starts
# (`--help`, then a real `daemon` invocation against a test `.oikb.yaml`)
# before wiring it into CI — oikb's optional dependencies (pymupdf, oci,
# google-api-python-client, ...) are exactly the kind of thing that can fail
# to freeze cleanly, and that's cheaper to catch by hand than to debug
# through a CI matrix. See README.md in this directory.
from PyInstaller.utils.hooks import collect_submodules

# oikb's 46 source connectors are loaded by name (a registry pattern), so
# PyInstaller's static import analysis won't see them on its own — collect
# all of `oikb.connectors` explicitly instead of hand-listing each one.
hidden_imports = collect_submodules("oikb.connectors")

a = Analysis(
    ["entry.py"],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="oikb",
    debug=False,
    strip=False,
    upx=False,
    console=True,
)
