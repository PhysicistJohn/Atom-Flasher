# Security policy

Flasher controls a physical firmware-write boundary. Treat vulnerabilities that can weaken device admission, firmware authenticity, operator confirmation, durable write evidence, process isolation, or post-write verification as safety issues as well as security issues.

## Supported code

The project does not currently promise long-term support for older snapshots. Security fixes target the current `main` branch and, once releases are tagged, the latest release. Reproduce a report against current code when it is safe to do so; never reproduce against hardware if doing so could start or interrupt a firmware write.

## Reporting a vulnerability

Do not publish exploit details, device identifiers, raw journals, signing material, or a proof of concept in a public issue.

Use GitHub's **Security** tab and **Report a vulnerability** control when it is available. If private vulnerability reporting is unavailable, open a public issue containing only a request for a private maintainer contact channel. Do not include technical details until a private channel is established.

Include, where applicable:

- the affected commit or release and macOS architecture;
- the affected contract or trust boundary;
- prerequisites and a minimal, non-destructive reproduction;
- expected and observed fail-closed behavior;
- whether a firmware write may have started or become indeterminate;
- sanitized logs with device serials, local paths, and tokens removed; and
- a proposed mitigation, if known.

There is no guaranteed response-time SLA. Please allow the maintainer to confirm impact and coordinate a fix before public disclosure.

## High-priority areas

Reports are especially important when they involve:

- acceptance of the wrong USB CDC or DFU device;
- bypass of the pinned firmware size, SHA-256, version, revision, or source commit;
- renderer-to-main IPC confusion or access outside the declared preload API;
- bypass of the native flash confirmation or local operator attestations;
- journal, ledger, lock, migration, or time-of-check/time-of-use failures;
- execution of an unintended `dfu-util` binary or argument injection;
- false success after an interrupted, failed, or unverified write;
- Electron navigation, origin, sandbox, or external-link escape; or
- dependency, packaging, signing, or release-artifact compromise.

## Safe handling

Do not attach a physical device when a software-only reproduction is sufficient. Never induce a disconnect, timeout, process kill, or power loss during a real write solely to demonstrate a report. Preserve all evidence if a write may have started, and do not clear the application's fail-closed state before the event is understood.

The repository must not contain API keys, signing certificates, notarization credentials, device journals, device serial numbers, or private firmware artifacts. Use environment-provided credentials only in an authorized release environment, and rotate any credential immediately if it is exposed.
