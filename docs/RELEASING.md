# Building cross-platform releases with GitHub Actions

This project ships a GitHub Actions workflow (`.github/workflows/release.yml`) that builds the Tauri desktop app for **Windows, macOS, and Linux** in parallel and attaches the installers to a GitHub Release. This is the step-by-step guide to setting it up and using it.

## What the pipeline produces

One job per OS, using GitHub's own hosted runners (no self-hosted infrastructure needed):

| Runner | Installers produced |
|---|---|
| `windows-latest` | `.msi`, `.exe` (NSIS) |
| `macos-latest` | `.dmg`, `.app` |
| `ubuntu-latest` | `.deb`, `.rpm`, `.AppImage` |

Each job builds independently (`fail-fast: false`, so one platform failing doesn't cancel the others), using the official [`tauri-apps/tauri-action`](https://github.com/tauri-apps/tauri-action) to run `tauri build` and collect the resulting bundles.

**Builds are unsigned.** No code-signing certificates or secrets are required to get this working, but that means:
- **Windows**: SmartScreen will show an "unrecognized app" warning on first run (users click "More info" → "Run anyway").
- **macOS**: Gatekeeper will refuse to open it normally; users right-click the app → **Open** once to bypass it (or run `xattr -cr /Applications/Open DesktopUI.app`).
- **Linux**: no equivalent warning.

Setting up real code signing later (a paid Windows/Apple Developer certificate) is a separate, optional step — see [Adding code signing later](#adding-code-signing-later).

## One-time setup

1. **Create the GitHub repository** (if it doesn't exist yet) at `github.com/markusbegerow/open-desktopui`, via the GitHub website or `gh repo create markusbegerow/open-desktopui --public --source=. `.
2. **Connect this local repo to it** and push:
   ```bash
   git remote add origin https://github.com/markusbegerow/open-desktopui.git
   git push -u origin master
   ```
3. Nothing else to configure — the workflow uses the automatically-provided `GITHUB_TOKEN`, no secrets need to be added manually.

## Cutting a real release

1. Bump the version number in **all three** places Tauri expects it to match (a normal Tauri release convention):
   - `apps/desktop/package.json` → `"version"`
   - `apps/desktop/src-tauri/tauri.conf.json` → `"version"`
   - `apps/desktop/src-tauri/Cargo.toml` → `[package] version`
2. Commit that version bump:
   ```bash
   git add apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/Cargo.toml
   git commit -m "Bump version to vX.Y.Z"
   git push
   ```
3. Tag and push the tag — this is what actually triggers the pipeline:
   ```bash
   git tag vX.Y.Z
   git push --tags
   ```
4. Watch it run under the repo's **Actions** tab. When all three platform jobs finish, a **draft** release named `Open DesktopUI vX.Y.Z` appears under **Releases**, with all the installers attached.
5. Open the draft, add release notes if you want, and click **Publish release** when you're happy with it. Nothing is public until you publish — the workflow deliberately only ever creates a *draft*.

## Testing the pipeline without cutting a release

Go to **Actions → Release → Run workflow** (the `workflow_dispatch` trigger) and run it on any branch. This builds all three platforms exactly the same way, but **does not** create or touch a GitHub Release — instead, each platform's installers are uploaded as a downloadable **workflow artifact** (visible at the bottom of that run's summary page) so you can sanity-check a build without publishing anything.

## Unsigned by design (for now)

This project isn't pursuing a Windows/Apple code-signing certificate at the moment — that's a deliberate call, not a stopgap blocking release. Unsigned installers work fine; users just click through one OS warning on first launch (see the README's Installation section and `release.yml`'s release-body text for the exact steps). If that changes later, see below.

## Adding code signing later

This repo doesn't have the certificates today, and there's no current plan to get them — but if that changes:

- **Windows**: needs a code-signing certificate; `tauri-action` supports it via the `TAURI_SIGNING_PRIVATE_KEY`/related secrets, or a traditional Authenticode cert passed through `signtool` — see [Tauri's Windows signing docs](https://tauri.app/distribute/sign/windows/).
- **macOS**: needs an Apple Developer ID certificate + notarization; `tauri-action` accepts `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` as repo secrets — see [Tauri's macOS signing docs](https://tauri.app/distribute/sign/macos/).
- Linux `.deb`/`.rpm`/`.AppImage` don't have an equivalent OS-level signing/notarization step.

Both are added purely as extra `env:`/`with:` entries on the existing `tauri-apps/tauri-action` step in `release.yml` — no structural change to the workflow needed.

## Known limitations

Honest, current-state list — update this as items get closed out, don't let it drift.

- **Installers are unsigned** (see above) until real certificates are added.
- **Credential storage is only partially encrypted.** The app's own copy of the Open WebUI API key and the oikb daemon API key (`settingsStore.ts`) are encrypted at rest via `tauri-plugin-stronghold` (Argon2-derived key, `lib.rs`). However:
  - The vault's own unlock passphrase is itself a random value stored in the plain (unencrypted) `settings.json` — see the threat-model note at the top of `src/lib/secureStore.ts`. This protects against casual exposure (a synced backup, a support screenshot, a naive credential-grep) but not against an attacker with full read access to the app's data directory.
  - oikb's own default connection token (`~/.config/oikb/config.yaml`, written by `oikb_config.rs`) remains plaintext YAML — oikb itself (vendored, unmodified) re-reads this file directly on every sync call, so a Stronghold detour there would only protect a copy oikb never actually consults. This is an accepted residual risk, not an oversight.
- **4 Open WebUI API integrations are unverified against a live server**: file upload, audio transcription, chat sharing, and message voting. Their request/response shapes were captured from a single instance and never confirmed against another. See the "unverified" comments in `openwebui_client.rs`.
- **The oikb daemon isn't a bundled sidecar yet** — packaged builds still require the user's machine to have Python/`uv` installed and a real `oikb-main` checkout, since `packaging/oikb-sidecar/` doesn't produce a real binary yet.
- **No auto-updater** — users must manually check for and download new releases.

## Auto-updates

`tauri-plugin-updater` is wired in (`tauri.conf.json`'s `plugins.updater`, checked from Settings > About's "Check for updates" button). It checks `https://github.com/markusbegerow/open-desktopui/releases/latest/download/latest.json`, a manifest `tauri-action` generates automatically (`includeUpdaterJson: true` in `release.yml`) and signs with a keypair.

**The keypair was generated locally during this session** (`npx tauri signer generate`) and is **not committed** — `.tauri-updater-key.pem`/`.pub` are gitignored. The **public** half is already embedded in `tauri.conf.json`'s `plugins.updater.pubkey`. The **private** half needs two things from you before a release will actually produce signed, verifiable updates:

1. Add it to the repo's GitHub Actions secrets as `TAURI_SIGNING_PRIVATE_KEY` (paste the full contents of `.tauri-updater-key.pem`), and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if you set one (this key was generated with no password — `--ci` mode).
2. **Decide where to back up `.tauri-updater-key.pem` itself, outside of GitHub Actions secrets** (a password manager, an offline vault, etc.) — this is the one piece of this whole setup that isn't safely re-generatable. If it's lost, every already-installed copy of the app has the *old* public key baked in and will refuse to trust updates signed by a new keypair, permanently breaking auto-updates for existing users until they manually reinstall.

Until both of those are done, releases build and publish fine, just without a valid updater manifest — installs work, only the auto-update check doesn't yet.

## Dependency audits

`npm audit` (from `apps/desktop/`) is clean. `cargo audit` (from `apps/desktop/src-tauri/`, needs `cargo install cargo-audit` once) is clean of blocking vulnerabilities as of this writing, with two explicitly ignored findings documented in `src-tauri/.cargo/audit.toml` (both unreachable given how this app actually uses their crates — see the comments there) plus four informational "unmaintained/unsound" warnings that don't fail the audit. Re-run both periodically and re-evaluate the ignores if the underlying crates change.
