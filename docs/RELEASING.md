# Releasing TinySA Flasher

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

`package:mac` removes the old `release/` directory before running any gate, then runs linting, machine-readable contract validation, all TypeScript checks, tests with coverage thresholds, and a clean production build. Electron Builder applies permissive localhost App Transport Security defaults after merging `mac.extendInfo`, so the fail-closed `afterPack` hook replaces that final dictionary before signing and removes unused media/Bluetooth permission descriptions. The same hook applies a complete, strict Electron fuse policy: it disables `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, CLI inspection, and the unprovisioned browser-specific V8 snapshot; enables cookie encryption, embedded ASAR integrity, ASAR-only application loading, and WebAssembly trap handlers; and fails if Electron adds an unreviewed fuse. The renderer currently loads from `file://` inside `app.asar`, so the file-protocol privilege fuse remains enabled as Electron requires; the exact production URL gate, sandbox, navigation denial, and CSP bound that privilege. Electron Builder then signs the completed bundle and all nested code inside-out with explicit ad-hoc identity `-`, the hardened runtime, and its Electron entitlements. Before a checksum file exists, the gate verifies and mounts the exact DMG read-only, extracts the exact ZIP, fully inspects both applications, proves their bundle metadata, ASAR bytes, signature identity, and fuse states match, requires a valid deep/strict ad-hoc signature with the hardened-runtime flag but no signing authority or Team Identifier, verifies the final permission/transport metadata and ASAR manifest, proves the sandboxed preload can require only Electron, and launches the extracted ZIP application through an isolated renderer/preload smoke path. Only after those checks pass does it write and verify `release/SHA256SUMS`.

The smoke path creates a temporary HOME and Chromium user-data directory, loads the production HTML and module graph in a hidden sandboxed window, and verifies the exact frozen preload API. It deliberately does not construct the application host or register operation handlers, so the renderer's initial capability request fails closed before snapshot or discovery. It exits before legacy migration, device construction, serial discovery, download, filesystem evidence creation, or DFU execution, and verifies that no firmware evidence directory appeared. It is safe to run without a connected analyzer.

To recheck artifacts without rebuilding:

```sh
npm run smoke:package
npm run artifacts:verify
```

Do not edit `SHA256SUMS`; regenerate it from final artifacts with `npm run artifacts:checksums` and publish it alongside the matching DMG and ZIP.

## Architecture and signing

The default local build targets the current Mac architecture. The initial tested output is Apple silicon (`arm64`); an Intel (`x64`) or universal artifact is a separate release target and must pass its own packaged smoke and hardware qualification on supported hardware. Never relabel one architecture's artifact as another.

The repository contains no Developer ID or notarization credentials. `npm run package:mac` always produces the explicit ad-hoc-signed local/CI artifact, and its smoke gate rejects any signing authority or Team Identifier. There is deliberately no script called “signed”: an ad-hoc signature protects local code integrity but does not establish publisher identity or Gatekeeper trust. A future public signed workflow must use a separately reviewed configuration and smoke policy; weakening this local-artifact gate in place would make local and public-release claims ambiguous.

An ad-hoc-signed artifact will trigger macOS trust warnings and is not suitable as a public release. A public macOS release requires an authorized Developer ID Application identity, hardened-runtime signing of the app and nested native code, Apple notarization, stapling, and independent `codesign --verify --deep --strict` plus Gatekeeper assessment of the final app. Supply secrets only through the authorized release environment; never add certificates, passwords, API keys, profiles, or notarization credentials to the repository or command history. The authorized release workflow must fail when any signature, notarization ticket, or assessment is missing. After signing/notarization changes the artifact bytes, regenerate and verify `SHA256SUMS`.

## Physical qualification

Automated checks do not flash hardware. Follow the dedicated physical-hardware procedure in [CONTRIBUTING.md](../CONTRIBUTING.md) only with an authorized recovery-capable ZS407 unit. Record whether physical qualification was performed. If it was not performed, label the build software-qualified only; do not imply that it is hardware release-qualified.

The qualification record should include the artifact SHA-256, app version, architecture, exact device starting identity, admitted DFU identity, external `dfu-util` provenance/version, post-reboot identity, and disposition of durable evidence. Sanitize serial numbers, host paths, and tokens before publishing any portion.

## Release checklist

- Working tree and index were clean before the release build.
- Version and contracts were reviewed; historical evidence readers remain compatible.
- `npm ci` and `npm run package:mac` passed on the recorded toolchain.
- DMG, ZIP, and `SHA256SUMS` correspond byte-for-byte.
- Signing/notarization status and supported architecture are stated accurately.
- Required physical qualification passed, or its absence is explicit.
- Release notes identify contract, persistence, trust-boundary, dependency, and firmware-target changes.
- Published files were downloaded once and checked against the published SHA-256 values.
