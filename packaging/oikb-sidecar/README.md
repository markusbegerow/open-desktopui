# oikb sidecar packaging

Freezes oikb (vendored unmodified in `../../oikb-main/`, or fetched by the
release workflow) into a standalone binary via PyInstaller, so a packaged Open
DesktopUI build doesn't need the end user to have Python or `uv` installed — see
`oikb.spec` for the details.

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

## How it plugs into the Tauri build

`.github/workflows/release.yml` does this for every platform of the release
matrix:

1. fetches the upstream oikb source if `oikb-main/` isn't there,
2. runs `build.sh` / `build.ps1` (with Python 3.12),
3. copies `dist/oikb[.exe]` to
   `apps/desktop/src-tauri/binaries/oikb-<target-triple>[.exe]`,
4. smoke-tests it with `--help`,
5. builds the app with `--config src-tauri/tauri.sidecar.conf.json`, which adds
   `"externalBin": ["binaries/oikb"]`.

The `externalBin` entry lives in `tauri.sidecar.conf.json` and not in
`tauri.conf.json` on purpose: Tauri's build script checks that every
`externalBin` file exists at build time, even for `cargo check` / `tauri dev`,
which would break the normal development loop for everyone without a built
binary.

`daemon_sidecar.rs`'s `spawn_daemon` tries `app.shell().sidecar("oikb")` first
and falls back to the development path `uv run oikb daemon` if that spawn fails.

## To try it by hand

Run a build once and exercise the binary — `./dist/oikb --help`, then a real
`daemon` invocation against a test `.oikb.yaml` — before trusting a release.
oikb's optional dependencies (`pymupdf`, `oci`, `google-api-python-client`, …)
are exactly the kind of thing that can fail to freeze cleanly (missing hidden
imports, native extension issues), and it is much cheaper to catch that locally
than through a CI matrix rebuild. To use the result in a local app build, copy
it to `apps/desktop/src-tauri/binaries/oikb-<target-triple>[.exe]` (the triple
comes from `rustc -Vv | grep host`) and build with
`npm run tauri build -- --config src-tauri/tauri.sidecar.conf.json`.
