# Architecture

TinySA Flasher is a deliberately small Electron application around one dangerous capability: writing one exactly admitted OEM or manifested local-custom image to a tinySA Ultra / Ultra+ ZS407. The renderer can request workflow operations, but it cannot access serial ports, files, processes, or Electron directly.

## Process and dependency boundaries

```text
renderer/App.tsx
    │ typed window.tinySaFlasher capability
    ▼
main/preload.ts ── named IPC messages ──► main/ipc-handlers.ts
                                            │
                                            ▼
                              application/flasher-application.ts
                                  │ serialized policy façade
                 ┌────────────────┼───────────────────┐
                 ▼                ▼                   ▼
      device/device-service  firmware-updater   native prompts/picker
                                   │                   │
                         ┌─────────┼─────────┐         ▼
                         ▼         ▼         ▼   local build store
                      artifact    DFU   persistence   capability
```

- `src/renderer` owns presentation and local form state. It treats every operation as asynchronous and receives only the preload API.
- `src/main/preload.ts` owns the renderer capability. It contains no policy and exposes no generic IPC primitive.
- `src/main/ipc-handlers.ts` validates and adapts independently named renderer operations; `src/application/flasher-application.ts` owns allowed-action policy, operation serialization, native confirmation/file-selection critical sections, and lifecycle admission.
- `src/main/main.ts` owns Electron, trusted-frame checks, native dialogs, the local-manifest picker adapter, and application/window lifecycle wiring.
- `src/device` owns CDC discovery, the wire protocol, exact ZS407 admission, telemetry, and the output-off lifecycle.
- `src/core/firmware-updater.ts` coordinates the update policy and irreversible transaction state through narrow artifact, DFU, device, clock, and durable-evidence collaborators.
- `src/core/firmware-artifact.ts` owns bounded acquisition, pinned length/hash verification, cache installation for the canonical release, and the admitted open-descriptor capability used at the write boundary.
- `src/core/local-firmware-build.ts` owns strict manifested-build parsing, binary/vector/version verification, secure native-file reads, and owner-only content-addressed installation. `src/main/local-firmware-target-picker.ts` turns that native-only state into an opaque, re-verifying artifact capability; paths never cross renderer IPC.
- `src/dfu` owns external utility discovery/version admission, DFU descriptor parsing, exact invocation through inherited firmware descriptor 3 (`/dev/fd/3`), and bounded process observation.
- `src/core/persistence` owns durable evidence layouts and version-specific evidence readers/writers. Migration consumes those contracts; steady-state persistence must never depend on migration code.
- `contracts/` contains versioned, machine-readable public composition and release contracts. `npm run check:contracts` checks them against their schemas and code projection.

Dependency direction runs inward from the Electron adapters to typed domain contracts. The renderer never imports device, filesystem, network, or process implementations. Core update code sees the physical analyzer through its narrow device interface rather than through Electron.

## Trust boundaries

All external data is untrusted until checked at its receiving boundary:

- Renderer requests are accepted only from the main frame at the selected packaged file URL or exact development origin, and payloads are runtime-validated.
- Serial candidates require the exact CDC USB ID before connection; command responses are bounded and parsed before becoming identity evidence.
- The OEM download uses HTTP, so only the pinned length and SHA-256 establish artifact integrity.
- Local custom selection is a zero-argument renderer operation. A native picker supplies the path only to main; the strict manifest and adjacent binary are opened without following symlinks, must be owned and not group/world-writable, and are copied into app-owned content-addressed storage. Cancelling the picker does not call the updater.
- A custom manifest’s `qualified-on-zs407` value is a declaration that must retain an evidence SHA-256. It is not independently reproduced by the app and never changes the post-flash device classification from `custom-unqualified` to OEM.
- `dfu-util` is host-supplied. The app admits exactly version `0.11` and binds invocation to the re-enumerated path, serial, alt setting, and internal-flash geometry; provenance of that executable remains a documented host trust input. Firmware bytes are supplied only through inherited descriptor 3 on platforms with `/dev/fd` semantics. Unsupported platforms fail closed instead of falling back to a mutable pathname.
- Persisted JSON and lock files are untrusted input on every process start. Versioned readers reject malformed, unknown, conflicting, stale, or indeterminate evidence.
- The native main-process confirmation is the final local-intent boundary. It includes the exact preparation and target kind/ID/version/image SHA-256 plus the custom-manifest SHA-256 when applicable; renderer text cannot manufacture it.

Atomizer owns normal operational USB sessions. TinySA Flasher owns CDC and DFU access only during its dedicated update session. Do not run both applications against the analyzer at the same time.

## Transaction and evidence model

The active transaction is fail-closed. A preparation records the full selected target, device, physical-attestation, screen, artifact, and CDC continuity evidence. Retargeting is prohibited after this point. A prepared custom session may only reopen or re-admit the exact persisted manifest/target; a different manifest cannot replace it. Immediately before the child process starts, the updater reacquires the durable journal mutex, proves the expected journal generation, rechecks the exact DFU fingerprint, installs the write-owner lock, and durably records write start. It then hashes the firmware with positioned reads from one open regular-file descriptor, verifies stable `fstat` identity/metadata around that read, and passes the still-open descriptor to `dfu-util` as child fd 3. The admitted capability contains no artifact pathname, so the verified-file-to-child boundary cannot silently reopen a swapped directory entry.

Once a write may have started, timeout, output volume, renderer state, or application shutdown cannot turn uncertainty into a retry. Success requires `dfu-util` completion plus exact post-reboot CDC/device/firmware evidence. The completed journal is archived into the completed-ledger layout before ownership is released. A started, indeterminate, malformed, conflicting, or orphaned record blocks another write for manual investigation.

Unprepared custom selection is intentionally process-local and is not journaled. After restart the operator selects it again. Prepared/not-started custom transactions are durable: startup reconstructs only their deterministic app-owned paths and re-verifies both files. Missing or mismatched files leave the write closed and expose only exact native re-admission. An abnormal historical unprepared custom record is recovered as failed/not-started; the app permits an explicit switch back to OEM or exact USB reconnection followed by pathless custom re-selection, but keeps download, prepare, and flash disabled until one target is coherently admitted.

Production evidence on macOS is stored under:

```text
~/Library/Application Support/TinySA Flasher/firmware/
```

`npm run dev` instead verifies and tightens an owner-only, non-symlink repository-local `.dev/user-data/`, sets it as Electron user data, and disables legacy discovery only in the unpackaged development process. It must never copy, delete, or advance production evidence. The development host also gives Electron one payload-free inherited pipe. EOF irreversibly removes IPC handlers and renderer trust and destroys the window; the `activate` lifecycle cannot recreate it. This kernel lifetime binding still fires when the host is killed without cleanup, while an operation already running in the main-process application remains alive to finish its durable safety state. The packaged runtime smoke uses a new temporary home and user-data directory, loads the production renderer and frozen preload API in a hidden sandboxed window without constructing the application/device/migration host, verifies that no firmware directory was created, and then deletes the temporary directory.

`npm run inspect:evidence -- --path /absolute/firmware` is intentionally read-only. It refuses symbolic links in every existing path component, never follows nested symlinks, proves the path components and traversed entries stayed stable, hashes regular files, summarizes selected non-sensitive state fields, and returns exit status `2` when locks, malformed or unclassifiable active journals, or other obvious hazards are present. It is an inventory aid, never authorization to delete evidence or retry a flash.

## State and contract evolution

Persisted schemas and public JSON contracts are append-only compatibility boundaries. A new OEM target release must not mutate the meaning of an old completed ledger. Add a canonical release record and an immutable historical reader; then update the active target projection explicitly. Local custom targets retain their complete v2 target metadata and manifest digest rather than borrowing OEM release identity. Unknown future schema versions fail closed until a reviewed reader or migration exists.

When changing IPC, update the named channel, preload capability, global renderer declaration, main handler, runtime validation, and tests together. When changing a public or persistence contract, add rejection tests for stale, malformed, conflicting, and unsupported versions as well as a success case.

## Development modes

- `npm run dev` starts Vite at the fixed strict origin `http://127.0.0.1:5173`, builds main/preload, and launches Electron in a separate process group with an inherited host-lifetime pipe. Renderer edits use HMR. Application, main, preload, core, device, and DFU edits stage a rebuilt bundle; the development host never signals or force-kills a running Electron process, and restarts it only after the developer quits normally when safe. If the host stops or is killed, kernel EOF permanently quarantines and destroys that renderer while an already admitted main-process operation continues safely. The app cannot recreate a window for that lifetime; quit it normally when safe and relaunch through the host.
- `npm run dev:safe` starts only the renderer with an unmistakable synthetic API. It has no Electron, serial, filesystem, external/firmware-download network, or DFU capability; loopback Vite/HMR traffic still serves the development page. Its final flash action always returns cancelled. Use this mode for routine layout and workflow work.
- Unit and UI tests use injected transports, updater runtimes, temporary directories, and a synthetic preload API. Automated tests must never discover or open physical hardware.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for change rules and [RELEASING.md](./RELEASING.md) for the release gate.
