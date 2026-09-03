# Model PK V1 Compatibility Report

## Runtime policy

| Contract | Value |
|---|---|
| DSH runtime | No exact package-version or source-commit lock |
| Validated build baseline | `0.1.1-rc.2` / `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` |
| Plugin | `@yuanyang749/dsh-model-pk@0.1.1` |
| Node | `^22.19 || >=24` |
| Host OS | macOS arm64 / x64; Windows arm64 / x64 |

## Implemented compatibility probes

| Probe | Evidence / behavior |
|---|---|
| DSH identity | Installed package version and optional source commit are recorded for diagnostics; a mismatch does not block execution by itself. |
| Host/Client bundle | Independent Host ESM and browser CJS bundle; additive settings.section slot. |
| RPC trust fence | `/model-pk` and `/model-pk-native` are separately registered with `authority: loopback`. |
| Model identity | Versioned JCS `modelConfigId`, redacted Provider profile snapshot, Adapter/serializer versions, retry policy, revision, context window and independently resolved output-token capability. The pinned pi-ai catalog supplies exact built-in protocol/capability facts; custom routes use their redacted profile. |
| Harness | Complete system prompt, six exact tools, Agent Loop/options, context policy, platform sandbox policy and versions enter one JCS fingerprint. The `bash` tool contract maps to bash on macOS and PowerShell on Windows. |
| Session | A fresh unpublished Agent/session is checked for `firstLiveSeq=0`, no replay seed/history, idle identity, and exactly the pinned `permission/preset=model-pk-workspace`, `sandbox/mode=workspace-write` and `approval/policy=never` bootstrap controls, then destroyed. No Provider request is sent. |
| Filesystem | Rust helper rejects symlink/reparse points, hardlinks, mount/volume boundaries and special files using fd-relative Unix traversal or checked Windows handles. Windows manifests also reject alternate data streams, case-folding collisions and invalid/reserved path components. |
| Execution | macOS uses deny-default Seatbelt plus a process group. Windows uses an AppContainer with the outbound-network capability, explicit Attempt ACLs and a kill-on-close Job Object. The probe proves workspace writes and network access while denying sibling reads, shared temp, secret environment and background orphans. On Windows it tests a public endpoint because AppContainer loopback requires a separate machine-level exemption; macOS keeps the deterministic loopback probe. |
| Control capacity | Fixed files are physically allocated with `F_PREALLOCATE` (macOS) or `FileAllocationInfo` (Windows), flushed, and tested through both checksum-protected generations. |
| Recovery | STARTING publication, execution unknown window, every FINALIZING stage, stale Seal and pending Delete converge after restart. |

The running Host writes the authoritative machine report to `$DSH_HOME/model-pk/v1/control/compatibility-report.json`. Any failed proof sets `executionEnabled=false`; Draft, diagnostics and storage views remain available while Start stays blocked.

## Local build evidence

The repository gate is:

```bash
pnpm check
```

It runs strict TypeScript checking, Vitest suites and both Host/Client production builds. Native tests use the compiled Rust binary and include deterministic snapshot/materialization, JCS tree identity, traversal rejection, fencing, capacity generations and the current platform's sandbox isolation. CI runs the same gate on macOS 15 arm64/x64, Windows Server 2025 x64 and Windows 11 arm64; Windows Rust code is additionally cross-checked with `cargo check --target x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc` during development.

Windows AppContainer compatibility probes allow up to 30 seconds for each
PowerShell process to account for cold startup on hosted runners; macOS probes
retain the 5-second budget. A timeout remains a blocking isolation failure and
reports the exact probe stage and captured output instead of an ambiguous null
exit code. Windows writable Attempt directories receive both the profile SID
DACL and an inherited Low Integrity label so AppContainer writes remain visible
in the sealed workspace instead of being denied or virtualized.

## Release matrix still enforced dynamically

- Each release runner builds and hashes its own `darwin-arm64`, `darwin-x64`, `win32-arm64` or `win32-x64` optional package.
- Real DeepSeek/pi-ai Provider fixtures are recorded separately from Fake Adapter failure injection.
- pi-ai routes without an observable supported protocol remain BLOCKED.
- Image experiments remain BLOCKED unless the selected models, DSH attachment limits, normalized-reference readback and version-pinned deterministic request projection all pass.

## Validated build evidence

The DSH `0.1.1-rc.2` build baseline is covered by strict TypeScript checking, the
version-pinned pi-ai request-image fixtures, normalized attachment-reference
tests, DeepSeek native vision capability tests, all Vitest suites, and both
Host/Client production builds. Artifacts for other OS/CPU combinations are
built and tested on their matching release runner rather than inferred from a
different platform. Other installed DSH versions are accepted when that host
passes the runtime Compatibility Gate before Start is enabled.
