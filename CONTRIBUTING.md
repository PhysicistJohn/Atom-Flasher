# Contributing to Flasher

Flasher controls a firmware-write boundary. Changes should remain small, reviewable, and fail closed when device identity, artifact provenance, durable state, or operator intent is uncertain.

## Development setup

Use macOS 12 or later, Node.js `22.23.1` (pinned in [`.node-version`](./.node-version)), and npm `10.9.8`. The supported runtime range is `>=22.23.1 <23`; Node.js 23 and later are not supported. A physical update additionally requires an externally installed `dfu-util 0.11`.

```sh
npm install --global npm@10.9.8
npm ci
npm run dev
```

The development command hot-reloads renderer changes and stages a rebuilt Electron bundle after successful changes under `src/application`, `src/main`, `src/device`, `src/dfu`, `src/core`, or the active release-manifest JSON. For write safety it never signals or terminates the running Electron process: quit normally when safe and the development host will start the staged build. A payload-free inherited pipe binds renderer authority to that host's kernel lifetime. If the host stops or is killed, Electron permanently removes IPC trust and destroys the renderer so another process that reclaims its loopback origin cannot inherit hardware capability; an operation already admitted in main continues to its durable terminal state. Quit the quarantined app normally when safe and relaunch through `npm run dev`. Its evidence is isolated under ignored `.dev/user-data/` and it does not migrate legacy production evidence; do not substitute that directory for release qualification against the packaged app.

Automated tests use injected transports, runtimes, temporary directories, and synthetic APIs; tests must never enumerate or open physical hardware.

Before opening a pull request, run the same primary checks as CI:

```sh
npm run check
npm audit --audit-level=low
```

`npm run check` includes ESLint, all TypeScript projects, tests, and a clean production build. Focused watch mode is useful during implementation, but the full gate is required before review.

Do not commit generated `dist/` or `release/` output, downloaded firmware, device journals, lock files, device serial numbers, signing credentials, or environment files.

## Contract architecture

Every interface must remain decomposable: a reviewer must be able to identify its owner, direction, inputs, outputs, validation boundary, failure semantics, compatibility/version policy, and tests without reconstructing those facts from unrelated implementation code.

The current contract layers are:

- `src/core/contracts.ts`: shared domain values, runtime schemas, active state, and firmware provenance.
- `src/application/flasher-application.ts` and `src/application/application-contract.ts`: serialized use-case façade, allowed-action policy, native-confirmation boundary, and lifecycle admission.
- `src/main/ipc-contract.ts`: named renderer-to-main operations and their request/response types.
- `src/main/preload.ts` and `src/renderer/global.d.ts`: the narrow renderer capability exposed by the sandboxed preload.
- `src/main/local-firmware-target-picker.ts` and `src/core/local-firmware-build.ts`: native-only custom-manifest selection, strict local-build admission, and app-owned content-addressed artifact capabilities. Renderer IPC must never accept or return a filesystem path.
- `src/device/protocol.ts`, `src/device/serial-transport.ts`, and `src/device/device-service.ts`: byte/command protocol, serial I/O, and device-admission ownership, respectively.
- `src/core/firmware-updater.ts`: update-state coordination across artifact, device, DFU, evidence, and post-write collaborators.
- `src/core/firmware-artifact.ts` and `src/dfu/`: pinned artifact acquisition/cache and external DFU utility admission/execution.
- `src/core/persistence/`: immutable evidence layouts/schemas plus durable file, inspection, and release-registry operations.
- `contracts/releases/`: immutable pinned OEM release manifests. The active manifest is imported by `src/core/contracts.ts` and validated against pinned literals; never edit or reuse a historical release manifest.

When changing or adding an interface:

1. Keep one responsibility and one owner per contract. Prefer a small method or schema over an untyped option bag or generic IPC command.
2. Validate untrusted, cross-process, device, network, and persisted data at the receiving boundary. Derive TypeScript types from runtime schemas where practical.
3. Make success and failure results explicit. Never convert unknown identity, partial evidence, timeout, or indeterminate write state into success.
4. Version persisted or externally consumed shapes. Document compatibility and migration behavior before accepting an old or new shape.
5. Add contract tests for accepted values, rejected values, stale input, and failure behavior. IPC changes must be reflected consistently in the contract, preload, renderer declaration, main handler, and tests.
6. Preserve dependency direction: renderer code uses the preload API; preload uses declared IPC names; the main process owns Electron, filesystem, network, process, serial, and DFU capabilities.
7. Keep target identity immutable after preparation. A prepared custom session may reconstruct or re-admit only its exact persisted target; cancellation must be side-effect-free at the updater boundary, and no target operation is legal after write start.

Firmware release selection is versioned through immutable manifests: add a new file under `contracts/releases/`, point the runtime at it, and never edit or reuse a historical release manifest. A local-build manifest is not an OEM release manifest: its `qualified-on-zs407` value is a build-supplied declaration backed by an evidence digest, not OEM provenance; post-flash device identity remains custom-unqualified.

## Physical-hardware verification

Automated tests must never initiate a firmware write. A maintainer performs manual verification only for changes that affect device discovery, protocol parsing, firmware provenance/download, preflight, DFU admission/execution, durable evidence, IPC write controls, packaging, or post-write verification.

Use a dedicated, authorized tinySA Ultra / Ultra+ ZS407 test unit with a known recovery plan. Do not use production measurement equipment or a device whose existing journal state has not been preserved and understood.

Before testing:

1. Record the commit, macOS version, Mac architecture, packaged artifact SHA-256, and `dfu-util --version` output. The utility must report exactly `0.11`.
2. Run `npm ci`, `npm run check`, and `npm run package:mac` from a clean checkout.
3. Preserve any existing firmware evidence directory before launching the candidate build. Never delete a started or indeterminate session merely to make a test proceed.
4. Disconnect RF equipment and all unrelated USB devices. Confirm the test unit has adequate battery power and a stable direct USB connection.

Exercise safe pre-write cases first: reject a nonmatching serial device, reject ambiguous DFU enumeration, verify that cancelled native file selection and cancelled native write confirmation perform no updater mutation, reject a different custom target after preparation, and verify that stale preparation evidence cannot be reused. Do not create a power-loss or USB-disconnect fault during an actual write solely to test recovery behavior.

Perform an update only when the authorized test unit genuinely needs the selected target. For a local custom target, review the strict v1 manifest, adjacent binary digest, source/ChibiOS commits, qualification declaration and evidence digest, rollback plan, and exact native confirmation before authorizing it; a manifest declaration alone is not hardware release qualification. Follow the in-app self-test and RF-disconnection steps exactly, do not invoke `dfu-util` independently while the app owns the operation, and do not quit or disconnect during the write. Success requires the device to return as the expected CDC device and report the selected target’s exact version/revision and OEM-or-custom identity class. Do not repeat a completed flash solely for test coverage.

Record the selected target kind/ID/SHA-256, local manifest SHA-256 and qualification evidence when applicable, observed admission evidence, native confirmation result, DFU identity, write result, and post-write identity in the release notes or private test record. Remove device serials and local paths before sharing a sanitized report; never commit raw journals or lock files.

If physical verification is required but unavailable, mark it explicitly as not run and do not describe the change as release-qualified.

## Pull-request checklist

- The change has a focused purpose and no unrelated generated output.
- New or changed interfaces meet the contract rules above.
- Tests cover success, rejection, and failure-closed behavior.
- `npm run check` and `npm audit --audit-level=low` pass.
- Documentation is updated when behavior changes.
- Required physical verification is recorded, or clearly marked as not run.
- No secrets, device identifiers, firmware binaries, journals, or signing material are included.
