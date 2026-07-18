# Release notes template

Copy this into the GitHub Release description for each tag. Fill in every bracketed value; delete nothing that doesn't apply — state it as not performed instead.

## Flasher [version]

- Commit: `[40-character commit SHA]`
- Architecture: `[arm64 | x64]`
- DMG SHA-256: `[from release/SHA256SUMS]`
- ZIP SHA-256: `[from release/SHA256SUMS]`

### Signing status

- Developer ID Application: not used or claimed
- Notarization / stapling: not requested or claimed
- Signature: ad-hoc, hardened runtime (see attached `BUILD-PROVENANCE.json`)
- Install via Homebrew (`brew install --cask physicistjohn/tinysa-flasher/tinysa-flasher`) to avoid the Gatekeeper quarantine prompt, or see the manual-download instructions in `README.md`.

### Physical hardware qualification

- [ ] Performed on a real tinySA Ultra / Ultra+ ZS407 unit
- If performed, record: starting device identity, admitted DFU identity, external `dfu-util` version, post-reboot identity, and write disposition (sanitize serials/paths).
- If **not** performed, say so explicitly here. Do not describe the build as hardware release-qualified.

### Changes

- [Contract, persistence, trust-boundary, dependency, and firmware-target changes since the prior tag]

### Verification

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
```

Attach: `Flasher-[version]-[arch].dmg`, the matching `.zip`, `SHA256SUMS`, `PACKAGE-INSPECTION.json`, `BUILD-PROVENANCE.json`.
