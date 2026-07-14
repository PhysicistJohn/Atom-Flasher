# TinySA Flasher

TinySA Flasher is a focused, standalone desktop updater for the physical **tinySA Ultra / Ultra+ ZS407**. It has no runtime or build-time dependency on the TinySA/Atomizer repository.

The application intentionally supports one pinned OEM release:

| Field | Pinned value |
|---|---|
| Version | `tinySA4_v1.4-224-gc979386` |
| Source revision | `c97938697b6c7485e7cab50bca9af76996b7d671` |
| Image size | `185704` bytes |
| SHA-256 | `3c9847ff4d7b80561df2f2f1030a112703a083409ffb2ee11361b2413b7c1e41` |
| Download | `http://dfu.tinydevices.org/tinySA4/DFU/tinySA4_v1.4-224-gc979386.bin` |

The OEM host is HTTP. Transport is not treated as authenticity: the streamed response is bounded to the pinned byte length and the image is retained only after its exact SHA-256 matches.

## Safety model

TinySA Flasher fails closed at every write boundary:

- Physical admission requires exact USB CDC identity `0483:5740`, a ZS407 hardware response, a source revision, the required command surface, and `output off` before and after identification.
- Preflight records battery voltage, device ID, USB path/serial evidence, the exact LCD capture hash, image hash, and the local human’s self-test/RF-disconnection attestations.
- Only `dfu-util 0.11` is accepted.
- DFU admission requires exactly one `0483:df11` device, one alt-0 `@Internal Flash` target, a nonempty path/devnum/serial, base address `0x08000000`, and capacity for the pinned image.
- The exact DFU fingerprint is journaled, enumerated again immediately before write, and supplied to `dfu-util` with path and serial selectors.
- A native Electron dialog—not renderer text—creates the internal flash confirmation.
- Journal mutations use a durable cross-process mutex and exact-byte generation checks. Flash acquires a random-token owner lock, then atomically revalidates the ready preparation and records write start before `dfu-util` starts. A stale, started, or indeterminate session globally blocks another write.
- Once a DFU write may have started, an expected-duration timer or output-volume bound never terminates `dfu-util`. Output is retained within a fixed memory bound while the process is observed until exit.
- A completed write is not success until the device returns as exact CDC, matches available preflight serial evidence and the firmware device ID, and reports the exact pinned version/revision/full-source-commit tuple.
- Verified completed sessions move atomically from the active journal into a device/preparation-keyed ledger. Incomplete active sessions are never silently cleared.
- Electron enforces one application instance, trusted main-frame IPC origins, renderer sandboxing, and a no-quit boundary while write/post-write verification is active.

USB CDC and STM32 DFU do not expose a publicly proven common identifier on this hardware. The app records both identities and combines one-device admission, the local only-update-device attestation, exact DFU re-enumeration, and post-reboot CDC/device-ID checks. It does not claim that the CDC and DFU identifiers are cryptographically equivalent.

### External `dfu-util` trust boundary

TinySA Flasher does **not** bundle or cryptographically pin `dfu-util`. It discovers an externally installed executable from an explicit `TINYSA_DFU_UTIL` path or a bounded standard/PATH search and rejects version output other than `0.11`. The executable itself remains part of the host trust boundary. Packaging a vetted copy would require a separate provenance, update, source-offer, and GPL compliance design; the current application deliberately documents this boundary instead of claiming a hermetic flashing engine.

## Prior Atomizer journals

Before the updater is constructed, startup checks both legacy locations:

- `TinySA Atomizer/firmware`
- `TinySA Atomizer Dev/firmware`

A single legacy journal and its safety artifacts—including completed-ledger history—are copied without deleting the source. Identical copies are accepted. Conflicting journals create `legacy-migration-conflict-v1.json`; the new updater then remains locked for manual inspection instead of selecting a history. A durably installed migration marker records the consumed legacy path/hash manifest exactly once, so later launches ignore only those exact source copies: they cannot overwrite an advanced standalone journal or resurrect an archived one, while new or changed legacy evidence fails closed.

## Prerequisites

- macOS (the initial packaged target)
- Node.js 22 or newer
- npm `10.9.8`
- `dfu-util 0.11` for a physical update (`brew install dfu-util`)

## Development

Dependencies are version-pinned directly in this repository.

```sh
npm install
npm run dev
```

Checks and production build:

```sh
npm run check
```

Create unsigned local macOS DMG and ZIP artifacts:

```sh
npm run package:mac
```

Code signing and notarization credentials are deliberately not embedded in the repository.

## Manual recovery

Application evidence lives under the Electron user-data `firmware` directory. If the UI reports a started or indeterminate write:

1. Do **not** press Flash again.
2. Preserve `firmware-update-journal-v1.json`, `firmware-write.lock`, `firmware-journal.lock`, `preflight-*.json`, `result-*.json`, `completed-ledger-v1/`, and any `legacy-migration-v1.json` or `legacy-migration-conflict-v1.json` evidence.
3. Inspect the device’s physical state and USB identity independently.
4. Resolve or archive evidence manually only after determining whether the prior write completed.

The application intentionally provides no “clear lock and retry” button.

## Composition contract

[`contracts/flasher-application-v1.json`](./contracts/flasher-application-v1.json) is the machine-readable ownership, pinned-release, and safety-invariant contract consumed by the broader TinySA composition verifier.
