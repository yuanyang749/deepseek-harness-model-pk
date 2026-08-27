# Model PK V1 Compatibility Report

## Locked target

| Contract | Value |
|---|---|
| DSH package | `0.1.1-rc.2` |
| DSH commit | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` |
| Plugin | `dsh-model-pk@0.1.0` |
| Node | `^22.19 || >=24` |
| Host OS | macOS arm64 / x64; Windows arm64 / x64 |

## Implemented compatibility probes

| Probe | Evidence / behavior |
|---|---|
| DSH identity | Installed package version plus profile-supplied source commit must match exactly. |
| Host/Client bundle | Independent Host ESM and browser CJS bundle; additive settings.section slot. |
| RPC trust fence | `/model-pk` and `/model-pk-native` are separately registered with `authority: loopback`. |
| Model identity | Versioned JCS `modelConfigId`, redacted Provider profile snapshot, Adapter/serializer versions, retry policy, revision, context window and independently resolved output-token capability. The pinned pi-ai catalog supplies exact built-in protocol/capability facts; custom routes use their redacted profile. |
| Harness | Complete system prompt, six exact tools, Agent Loop/options, context policy, platform sandbox policy and versions enter one JCS fingerprint. The `bash` tool contract maps to bash on macOS and PowerShell on Windows. |
| Session | A fresh unpublished Agent/session is checked for `firstLiveSeq=0`, no replay seed/history, idle identity, and exactly the pinned `sandbox/mode=read-only` plus `approval/policy=never` bootstrap controls, then destroyed. No Provider request is sent. |
| Filesystem | Rust helper rejects symlink/reparse points, hardlinks, mount/volume boundaries and special files using fd-relative Unix traversal or checked Windows handles. Windows manifests also reject alternate data streams, case-folding collisions and invalid/reserved path components. |
| Execution | macOS uses deny-default Seatbelt plus a process group. Windows uses an AppContainer with no network capabilities, explicit Attempt ACLs and a kill-on-close Job Object. The probe proves workspace writes while denying sibling reads, shared temp, secret environment, loopback network and background orphans. |
| Control capacity | Fixed files are physically allocated with `F_PREALLOCATE` (macOS) or `FileAllocationInfo` (Windows), flushed, and tested through both checksum-protected generations. |
| Recovery | STARTING publication, execution unknown window, every FINALIZING stage, stale Seal and pending Delete converge after restart. |

The running Host writes the authoritative machine report to `$DSH_HOME/model-pk/v1/control/compatibility-report.json`. Any failed proof sets `executionEnabled=false`; Draft, diagnostics and storage views remain available while Start stays blocked.

## Local build evidence

The repository gate is:

```bash
pnpm check
```

It runs strict TypeScript checking, Vitest suites and both Host/Client production builds. Native tests use the compiled Rust binary and include deterministic snapshot/materialization, JCS tree identity, traversal rejection, fencing, capacity generations and the current platform's sandbox isolation. CI runs the same gate on macOS 15 arm64/x64, Windows Server 2025 x64 and Windows 11 arm64; Windows Rust code is additionally cross-checked with `cargo check --target x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc` during development.

## Release matrix still enforced dynamically

- Each release runner builds and hashes its own `darwin-arm64`, `darwin-x64`, `win32-arm64` or `win32-x64` optional package.
- Real DeepSeek/pi-ai Provider fixtures are recorded separately from Fake Adapter failure injection.
- pi-ai routes without an observable supported protocol remain BLOCKED.
- Image experiments remain BLOCKED unless the selected models, DSH attachment limits, normalized-reference readback and version-pinned deterministic request projection all pass.

## Verified upgrade evidence

The DSH `0.1.1-rc.2` upgrade is covered by strict TypeScript checking, the
version-pinned pi-ai request-image fixtures, normalized attachment-reference
tests, DeepSeek native vision capability tests, all Vitest suites, and both
Host/Client production builds. Artifacts for other OS/CPU combinations are
built and tested on their matching release runner rather than inferred from a
different platform; every installed host must still pass the runtime
Compatibility Gate before Start is enabled.
