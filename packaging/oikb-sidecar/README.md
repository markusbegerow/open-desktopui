# oikb sidecar packaging

Freezes oikb (vendored unmodified in `../../oikb-main/`) into a standalone
binary via PyInstaller, so a packaged Open DesktopUI build doesn't need the
end user to have Python or `uv` installed — see `oikb.spec` for the details.

## Building

PyInstaller does not cross-compile — run the script for your current OS:

```bash
# macOS / Linux
./build.sh

# Windows
./build.ps1
```

Both install oikb (with its `all` extras — every optional connector
dependency, since we don't know ahead of time which sources a given user
will configure) into a throwaway `.build-venv/`, then run PyInstaller. The
resulting binary lands at `dist/oikb` (`dist/oikb.exe` on Windows).

## Before wiring this into CI

**Run a build once by hand and actually exercise the binary** —
`./dist/oikb --help`, then a real `daemon` invocation against a test
`.oikb.yaml` — before trusting `.github/workflows/release.yml`'s automated
build of it. oikb's optional dependencies (`pymupdf`, `oci`,
`google-api-python-client`, ...) are exactly the kind of thing that can fail
to freeze cleanly (missing hidden imports, native extension issues), and
that's much cheaper to catch and fix locally than through a CI matrix
rebuild-and-wait loop.

## How this plugs into the Tauri build — not fully wired yet

`daemon_sidecar.rs`'s `spawn_daemon` already tries `app.shell().sidecar("oikb")`
first and falls back to the dev-mode `uv run oikb daemon` path if that spawn
fails — so the Rust side is ready.

**What's deliberately not done yet:** adding `"externalBin": ["binaries/oikb"]`
to `apps/desktop/src-tauri/tauri.conf.json`. Tauri's build script validates
that every `externalBin` entry resolves to a real file *at build time* —
including a plain `cargo check`/`tauri dev`, not just `tauri build` — so
wiring it in before a real binary exists at
`apps/desktop/src-tauri/binaries/oikb-<target-triple>[.exe]` would break the
ordinary dev loop for everyone who doesn't already have one built. Do these
together, not separately:

1. Run `build.sh`/`build.ps1` (or a future `release.yml` step) to produce
   `dist/oikb[.exe]`.
2. Copy/rename it to
   `apps/desktop/src-tauri/binaries/oikb-<target-triple>[.exe]` (get the
   triple via `rustc -Vv | grep host`).
3. Add the `externalBin` entry to `tauri.conf.json` in the same change.
4. Only then wire an automated build+copy step into `release.yml`'s matrix,
   once per platform.
