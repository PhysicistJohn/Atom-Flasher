# Releasing Flasher

This repository currently packages macOS 12+ DMG and ZIP artifacts. A locally built package is a test artifact until signing, notarization, hardware qualification, and release provenance are recorded.

## Preconditions

1. Use a clean checkout on macOS with Node `22.23.1` from `.node-version` and npm `10.9.8` from `packageManager`.
2. Confirm the canonical release record, public application contract, generated code projection, historical persistence readers, README table, and tests agree.
3. Confirm there are no journals, firmware images, serial numbers, signing files, or credentials in Git.
4. Install exactly from the lockfile with `npm ci`; do not update dependencies during a release build.
5. Record the commit, macOS version, host architecture, Node/npm versions, Electron version, and external `dfu-util --version` output used for any physical qualification.

## Build and automated gate

```sh
npm ci
npm run package:mac
```

`package:mac` first requires a clean Git index, tracked tree, and untracked tree. It asks Git to report ignored paths as well and permits only `node_modules/`, `coverage/`, `dist/`, and `release/`: the installed dependency tree and outputs recreated by this pipeline. Ignored `.env` files, `.dev` state, firmware images, journals, logs, and every other ignored path are blockers. The same gate runs again after checks, after Electron Builder, and after the final records are verified. It records and re-verifies the exact 40-character commit rather than inferring source from a version string.

After the initial gate, `package:mac` removes the old `release/` directory, then runs linting, machine-readable contract validation, all TypeScript checks, tests with coverage thresholds, release-tool policy tests, and a clean production build. Electron Builder applies permissive localhost App Transport Security defaults after merging `mac.extendInfo`, so the fail-closed `afterPack` hook replaces that final dictionary before signing and removes unused media/Bluetooth permission descriptions. The same hook applies a complete, strict Electron fuse policy: it disables `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, CLI inspection, and the unprovisioned browser-specific V8 snapshot; enables cookie encryption, embedded ASAR integrity, ASAR-only application loading, and WebAssembly trap handlers; and fails if Electron adds an unreviewed fuse. The renderer currently loads from `file://` inside `app.asar`, so the file-protocol privilege fuse remains enabled as Electron requires; the exact production URL gate, sandbox, navigation denial, and CSP bound that privilege. Electron Builder then signs the completed bundle and all nested code inside-out with explicit ad-hoc identity `-`, the hardened runtime, and its Electron entitlements. Before a provenance or checksum record exists, the gate verifies and mounts the exact DMG read-only, extracts the exact ZIP, fully inspects both applications, proves their bundle metadata, ASAR bytes, signature identity, and fuse states match, requires a valid deep/strict ad-hoc signature with the hardened-runtime flag but no signing authority or Team Identifier, verifies the final permission/transport metadata and ASAR manifest, proves the sandboxed preload can require only Electron, and launches the extracted ZIP application through an isolated renderer/preload smoke path.

The successful smoke atomically writes deterministic external `release/PACKAGE-INSPECTION.json`. The provenance gate independently rehashes both containers and atomically writes deterministic external `release/BUILD-PROVENANCE.json`, recording the clean commit, host and running artifact architecture, exact Node/npm/Electron versions, artifact names/sizes/SHA-256 values, observed ad-hoc CDHash/identifier/flags, fuse state, and exact local/CI policy. Neither record contains a timestamp, hostname, local path, or macOS version, and neither is embedded in the app, DMG, or ZIP. `release/SHA256SUMS` then exactly covers the DMG, ZIP, package inspection, and build provenance. Both checksum and provenance verification rerun before completion.

The smoke path creates a temporary HOME and Chromium user-data directory, loads the production HTML and module graph in a hidden sandboxed window, and verifies the exact frozen preload API. It deliberately does not construct the application host or register operation handlers, so the renderer's initial capability request fails closed before snapshot or discovery. It exits before legacy migration, device construction, serial discovery, download, filesystem evidence creation, or DFU execution, and verifies that no firmware evidence directory appeared. It is safe to run without a connected analyzer.

To recheck artifacts without rebuilding:

```sh
npm run smoke:package
npm run artifacts:provenance:verify
npm run artifacts:verify
```

Do not edit `PACKAGE-INSPECTION.json`, `BUILD-PROVENANCE.json`, or `SHA256SUMS`. Regenerate all three through `package:mac` and publish them alongside the matching DMG and ZIP.

## Architecture and signing

The default local build targets the current Mac architecture. The initial tested output is Apple silicon (`arm64`); an Intel (`x64`) or universal artifact is a separate release target and must pass its own packaged smoke and hardware qualification on supported hardware. Never relabel one architecture's artifact as another.

The repository contains no Developer ID or notarization credentials. `npm run package:mac` always produces the explicit ad-hoc-signed local/CI artifact, and its smoke gate rejects any signing authority or Team Identifier. Its provenance states `not-used-or-claimed` for Developer ID and `not-requested-or-claimed` for notarization and stapling; those are workflow limitations, not public trust claims. There is deliberately no script called “signed”: an ad-hoc signature protects local code integrity but does not establish publisher identity or Gatekeeper trust. A future public signed workflow must use a separately reviewed configuration and smoke policy; weakening this local-artifact gate in place would make local and public-release claims ambiguous.

An ad-hoc-signed artifact will trigger macOS trust warnings and is not suitable as a public release. A public macOS release requires an authorized Developer ID Application identity, hardened-runtime signing of the app and nested native code, Apple notarization, stapling, and independent `codesign --verify --deep --strict` plus Gatekeeper assessment of the final app. Supply secrets only through the authorized release environment; never add certificates, passwords, API keys, profiles, or notarization credentials to the repository or command history. The authorized release workflow must fail when any signature, notarization ticket, or assessment is missing. After signing/notarization changes the artifact bytes, regenerate and verify `SHA256SUMS`.

### Current distribution decision

The source repository (`PhysicistJohn/TinySA_Flasher`) is private. Built artifacts are published separately to the public `PhysicistJohn/TinySA_Flasher-releases` repo, which holds only GitHub Releases (DMG, ZIP, `SHA256SUMS`, `PACKAGE-INSPECTION.json`, `BUILD-PROVENANCE.json`) and its own public-facing README with install/verification instructions — never source. Public distribution ships the ad-hoc build described above through a Homebrew Cask (`physicistjohn/tinysa-flasher/tinysa-flasher`) pointed at that releases repo, rather than an unsigned direct download alone. Homebrew's cask downloader does not apply the browser quarantine attribute that triggers Gatekeeper's "unidentified developer" dialog, so this removes the install-time prompt for that install path without changing the underlying trust posture: there is still no Developer ID signature and no Apple notarization, and users who download the DMG directly (outside Homebrew) will still see the standard Gatekeeper block.

`.github/workflows/release.yml` publishes to the separate public repo on every `v*` tag push. The default `GITHUB_TOKEN` cannot write to a different repository, so this requires a fine-grained personal access token scoped to only `PhysicistJohn/TinySA_Flasher-releases` with `contents: write`, stored as the `RELEASES_REPO_TOKEN` secret on this (private) repo. Create it at github.com under Settings → Developer settings → Fine-grained tokens, then:

```sh
gh secret set RELEASES_REPO_TOKEN --repo PhysicistJohn/TinySA_Flasher --app actions
```

The workflow always opens the release as a **draft**: the notes template has placeholders (commit, checksums, physical qualification disposition) that must be filled in by a maintainer before publishing. Never widen the token's scope beyond that one repository, and never commit it.

Enrolling in the Apple Developer Program ($99/year) and building the authorized signed/notarized workflow described above remains the correct upgrade path if distribution scope grows. That workflow must be added as a separately reviewed configuration and smoke policy per the paragraph above — do not retrofit conditional signing into `tools/after-pack.mjs`, `tools/release-gate.mjs`, or `npm run package:mac`, which exist specifically to make the ad-hoc/local-test claim unambiguous.

## Physical qualification

Automated checks do not flash hardware. Follow the dedicated physical-hardware procedure in [CONTRIBUTING.md](../CONTRIBUTING.md) only with an authorized recovery-capable ZS407 unit. Record whether physical qualification was performed. If it was not performed, label the build software-qualified only; do not imply that it is hardware release-qualified.

The qualification record should include the artifact SHA-256, app version, architecture, exact device starting identity, admitted DFU identity, external `dfu-util` provenance/version, post-reboot identity, and disposition of durable evidence. Sanitize serial numbers, host paths, and tokens before publishing any portion.

## Release checklist

- The automated release gate proved the index, tracked tree, and untracked tree clean at every checkpoint; ignored state was confined to the four declared generated/dependency roots.
- Version and contracts were reviewed; historical evidence readers remain compatible.
- `npm ci` and `npm run package:mac` passed on the recorded toolchain.
- DMG, ZIP, `PACKAGE-INSPECTION.json`, `BUILD-PROVENANCE.json`, and `SHA256SUMS` correspond byte-for-byte.
- Signing/notarization status and supported architecture are stated accurately.
- Required physical qualification passed, or its absence is explicit.
- Release notes identify contract, persistence, trust-boundary, dependency, and firmware-target changes.
- Published files were downloaded once and checked against the published SHA-256 values.
