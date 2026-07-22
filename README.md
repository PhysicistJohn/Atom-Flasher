<p align="center"><img src="docs/brand/logo.jpg" alt="AtomOS Flasher" width="520"></p>

# AtomOS Flasher

AtomOS Flasher is a standalone, fail-closed desktop firmware updater for the physical **tinySA Ultra / Ultra+ ZS407**. It is part of the AtomOS suite but has no runtime or build-time dependency on the [Atom-Atomizer](https://github.com/PhysicistJohn/Atom-Atomizer) application repository.

The `tinysa-*` schema filenames, device IDs, and v1 source identifier are stable
compatibility names. Current product, repository, source, and v2 schema IDs use
AtomOS, `Atom-Flasher`, and `Atom-Firmware`.

The application has one pinned OEM release. It is the only network-acquired target and the default restore/update target:

| Field | Pinned value |
|---|---|
| Version | `tinySA4_v1.4-224-gc979386` |
| Source revision | `c97938697b6c7485e7cab50bca9af76996b7d671` |
| Image size | `185704` bytes |
| SHA-256 | `3c9847ff4d7b80561df2f2f1030a112703a083409ffb2ee11361b2413b7c1e41` |
| Download | `http://dfu.tinydevices.org/tinySA4/DFU/tinySA4_v1.4-224-gc979386.bin` |

[`contracts/releases/oem-zs407-c979386-v1.json`](./contracts/releases/oem-zs407-c979386-v1.json) is the canonical immutable release manifest. The runtime imports it directly and validates every field against pinned literals in `src/core/contracts.ts`.

The OEM host is HTTP. Transport is not treated as authenticity: the streamed response is bounded to the pinned byte length and the image is retained only after its exact SHA-256 matches.

The operator may instead select a manifested local custom build from [Atom-Firmware](https://github.com/PhysicistJohn/Atom-Firmware). Current v2 manifests declare `PhysicistJohn/Atom-Firmware`; historical v1 manifests with `PhysicistJohn/TinySA_Firmware` remain readable as an exact compatibility contract. In a sibling development checkout the native picker starts in `../Atom-Firmware`, with `../TinySA_Firmware` retained only as a compatibility fallback; after a manifest passes admission, later selections in that app session start in its verified directory. Cancelled or rejected selections never replace that directory. Selection uses a native main-process file picker; renderer IPC accepts no path. The adjacent raw `.bin` and its strict manifest must agree on the ZS407/STM32F303 target, `0x08000000` load address, 8 KiB–240 KiB size, SHA-256, vector table, embedded version/revision, clean source and ChibiOS commits, reproducible-build assertion, qualification declarations, and operator-only flash policy. The app copies both files into owner-only, content-addressed storage and reopens and re-verifies them before use.

`qualified-on-zs407` is a manifest declaration that requires an immutable qualification-evidence SHA-256; the app does not independently reproduce that external evidence. A local build is never promoted to OEM provenance. The device-side identity remains `custom-unqualified`, while the journal separately retains the manifest’s build-qualification declaration and exact target identity. Matching custom version/revision text on a connected device does not prove installed bytes, so it never creates an “already current” shortcut; only this app’s just-completed durable write evidence can establish that exact result.

## Safety model

AtomOS Flasher fails closed at every write boundary:

- Physical admission requires exact USB CDC identity `0483:5740`, a ZS407 hardware response, a source revision, the required command surface, and `output off` before and after identification.
- Preflight requires at least 3.9 V battery voltage and records that reading, device ID, USB path/serial evidence, the exact LCD capture hash, image hash, and the local human’s self-test/RF-disconnection attestations.
- Only `dfu-util 0.11` is accepted.
- DFU admission requires exactly one `0483:df11` device, one alt-0 `@Internal Flash` target, a nonempty path/devnum/serial, base address `0x08000000`, and capacity for the exact selected image.
- The exact DFU fingerprint is journaled, enumerated again immediately before write, and supplied to `dfu-util` with path and serial selectors.
- The selected image is hashed with positioned reads from one already-open regular-file descriptor. Its device/inode, mode, owner, size, and modification time are checked before and after hashing; that same descriptor remains open through child exit and is inherited by `dfu-util` as `/dev/fd/3`. No verified pathname is reopened at the write boundary.
- A native Electron dialog, not renderer text, creates the internal flash confirmation and names the exact target kind, ID, version, image SHA-256, preparation, and custom-manifest SHA-256 when applicable.
- Journal mutations use a durable cross-process mutex and exact-byte generation checks. Flash acquires a random-token owner lock, then atomically revalidates the ready preparation and records write start before `dfu-util` starts. A stale, started, or indeterminate session globally blocks another write.
- The active firmware-state root is current-user-owned and mode `0700`; a safe legacy `0755` root is tightened, while any foreign-owned or group/world-writable root fails closed. Reserved evidence must be a stable, current-user-owned, non-writable regular inode with one filesystem link, and unknown versioned evidence namespaces require manual inspection.
- Once a DFU write may have started, an expected-duration timer or output-volume bound never terminates `dfu-util`. Output is retained within a fixed memory bound while the process is observed until exit.
- A completed write is not success until the device returns as exact CDC, matches available preflight serial evidence and the firmware device ID, and reports the selected target’s exact version/revision with the expected OEM-or-custom identity class.
- Verified completed sessions move atomically from the active journal into a device/preparation-keyed ledger. Incomplete active sessions are never silently cleared.
- Electron enforces one application instance, trusted main-frame IPC origins, renderer sandboxing, and a no-quit boundary while write/post-write verification is active.
- OEM/custom retargeting is allowed only before preparation. A prepared custom transaction may re-admit only its exact persisted target metadata; once a write starts, all target selection is closed.

USB CDC and STM32 DFU do not expose a publicly proven common identifier on this hardware. The app records both identities and combines one-device admission, the local only-update-device attestation, exact DFU re-enumeration, and post-reboot CDC/device-ID checks. It does not claim that the CDC and DFU identifiers are cryptographically equivalent.

USB ownership is session-scoped. AtomOS Atomizer owns normal CDC analyzer/generator operation; AtomOS Flasher owns CDC discovery/preflight, DFU admission/write, and CDC post-write verification for the complete update session. Never let both applications access the same physical device: disconnect or close Atomizer before starting an update and finish or safely exit Flasher before reconnecting Atomizer.

If the app restarts with a prepared, not-started custom transaction, it first attempts to reopen the exact content-addressed manifest and binary from app-owned storage. If either file is absent or no longer reproduces the persisted target, flashing remains unavailable until the operator re-admits that exact manifest through the native picker. Cancellation changes no updater state; selecting a different target cannot retarget the preparation. Unprepared custom selections are intentionally not journaled and must be selected again after restart.

### External `dfu-util` trust boundary

AtomOS Flasher does **not** bundle or cryptographically pin `dfu-util`. It discovers an externally installed executable from an explicit `TINYSA_DFU_UTIL` path or a bounded standard/PATH search and rejects version output other than `0.11`. The executable itself remains part of the host trust boundary. Packaging a vetted copy would require a separate provenance, update, source-offer, and GPL compliance design; the current application deliberately documents this boundary instead of claiming a hermetic flashing engine.

## Prior Atomizer journals

Before the updater is constructed, startup checks both legacy locations:

- `TinySA Atomizer/firmware`
- `TinySA Atomizer Dev/firmware`

A single legacy journal and its safety artifacts, including completed-ledger history, are copied without deleting the source. Identical copies are accepted. Conflicting journals create `legacy-migration-conflict-v1.json`; the new updater then remains locked for manual inspection instead of selecting a history. A durably installed migration marker records the consumed legacy path/hash manifest exactly once, so later launches ignore only those exact source copies: they cannot overwrite an advanced standalone journal or resurrect an archived one, while new or changed legacy evidence fails closed.

## Prerequisites

- macOS 12 or later (the initial packaged target)
- Node.js `22.23.1` (pinned in `.node-version`)
- npm `10.9.8`
- `dfu-util 0.11` for a physical update (`brew install dfu-util`)

## Install

No prebuilt AtomOS Flasher release is currently published. The separate
[release repository](https://github.com/PhysicistJohn/Atom-Flasher-releases)
is a reserved distribution location, not an install source until it contains a
release with checksums and provenance. Use the development workflow below in
the meantime; do not install an unverified binary from another source.

## Development

Dependencies are version-pinned directly in this repository.

```sh
npm install --global npm@10.9.8
npm ci
npm run dev
```

The development command uses the strict renderer origin `http://127.0.0.1:5173`: renderer changes use HMR, while application, main, preload, core, device, DFU, and the active release-manifest JSON changes rebuild and stage a restart. Electron also receives a payload-free inherited lifetime channel owned by the development host. Kernel EOF permanently removes IPC trust and destroys the renderer if that host ends (even by SIGKILL), so a later process cannot inherit hardware capability by reclaiming port 5173. An operation already admitted to the main process, including a firmware write or post-write verification, continues to its durable terminal state; the host never signals or force-kills it. Quit the quarantined app normally when safe, then relaunch through `npm run dev`. Development evidence is isolated under ignored `.dev/user-data/`; unpackaged isolated development does not migrate production Atomizer evidence.

Checks and production build:

```sh
npm run check
npm run audit
```

The repository CI runs these commands from the lockfile on pinned Node.js and npm versions. `check` includes lint, typechecking, tests, and a clean production build. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the review checklist and physical-hardware qualification.

Create ad-hoc-signed local macOS DMG and ZIP test artifacts:

```sh
npm run package:mac
```

Packaging runs the full check first. The production renderer CSP has no network connection source; development-only HMR WebSocket access is injected only by the Vite development transform. A fail-closed post-pack hook (`tools/after-pack.mjs`) removes Electron's unused media/Bluetooth permission descriptions, replaces Electron Builder's permissive localhost transport defaults with an exact no-arbitrary-load/no-local-network policy, and pins the Electron fuse state before signing. Electron Builder then applies an inside-out ad-hoc hardened-runtime signature.

The local packaging command emits artifacts for the current Mac architecture. An ad-hoc signature establishes code integrity for local testing but is not a trusted Developer ID signature or a notarized public release. No Developer ID or notarization credential is embedded in the repository.

### External tool override

The standard Homebrew locations are discovered automatically. To test a specific executable, provide an absolute path when starting the app:

```sh
TINYSA_DFU_UTIL=/absolute/path/to/dfu-util npm run dev
```

The override must be executable and must identify itself as exactly `dfu-util 0.11`. It is a trust input, not a secret, and must not point to a repository script or an unreviewed download.

## Manual recovery

On macOS, production evidence lives under `~/Library/Application Support/Flasher/firmware/`. Inventory a copied or in-place evidence directory without changing it:

```sh
npm run inspect:evidence -- --path "/absolute/path/to/firmware"
```

The inspector refuses symbolic links in the requested path or evidence tree, hashes stable regular files, and exits `2` when it sees an obvious hazard, including a malformed or unclassifiable active journal. Its output is diagnostic only, not permission to clear evidence or flash again. If the UI reports a started or indeterminate write:

1. Do **not** press Flash again.
2. Preserve every `firmware-update-journal-v*.json`, `firmware-write.lock`, `firmware-journal.lock`, `preflight-*.json`, `result-*.json`, `completed-ledger-v*/`, and any `legacy-migration-v1.json` or `legacy-migration-conflict-v1.json` evidence.
3. Inspect the device’s physical state and USB identity independently.
4. Resolve or archive evidence manually only after determining whether the prior write completed.

The application intentionally provides no “clear lock and retry” button.

## Part of the AtomOS suite

- [Atom-Atomizer](https://github.com/PhysicistJohn/Atom-Atomizer): AI-native spectrum analyzer application.
- [Atom-Classifier](https://github.com/PhysicistJohn/Atom-Classifier): deployed local embedding classifier plus retained Bayesian RF research pipeline.
- [Atom-Firmware](https://github.com/PhysicistJohn/Atom-Firmware): reproducibly built tinySA firmware research and modernization.
- [Atom-Flasher](https://github.com/PhysicistJohn/Atom-Flasher): fail-closed firmware flasher.
- [Atom-NeptuneSDR-Twin](https://github.com/PhysicistJohn/Atom-NeptuneSDR-Twin): QEMU-backed firmware-executing digital twin of the NeptuneSDR/HAMGEEK P210.
- [Atom-SignalLab](https://github.com/PhysicistJohn/Atom-SignalLab): 3GPP and reference signal generation.
- [Atom-TinySA-Twin](https://github.com/PhysicistJohn/Atom-TinySA-Twin): Renode digital twin booting real ZS407 firmware.
- [Atom-Website](https://github.com/PhysicistJohn/Atom-Website): product site.

## Code map

The implementation is split into independently reviewable layers: shared runtime and persisted schemas in `src/core/contracts.ts`, renderer/main operations in `src/main/ipc-contract.ts`, the sandbox capability in `src/main/preload.ts`, the device protocol and transport under `src/device`, DFU tooling in `src/dfu/dfu-util.ts`, and update orchestration in `src/core/firmware-updater.ts`. The safety chain (write-started journaling, RF-off-before-flash, exact USB admission, and pinned SHA verification) is pinned by the tests under `tests/`.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the review checklist and mandatory manual verification rules. Security issues should follow [`SECURITY.md`](./SECURITY.md).
