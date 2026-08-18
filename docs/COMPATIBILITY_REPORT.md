# Model PK V1 Compatibility Report

## Locked target

| Contract | Value |
|---|---|
| DSH package | `0.1.0-rc.7` |
| DSH commit | `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` |
| Plugin | `dsh-model-pk@0.1.0` |
| Node | `^22.19 || >=24` |
| Host OS | macOS arm64 / x64 |

## Implemented compatibility probes

| Probe | Evidence / behavior |
|---|---|
| DSH identity | Installed package version plus profile-supplied source commit must match exactly. |
| Host/Client bundle | Independent Host ESM and browser CJS bundle; additive sidebar and overlay slots. |
| RPC trust fence | `/model-pk` and `/model-pk-native` are separately registered with `authority: loopback`. |
| Model identity | Versioned JCS `modelConfigId`, redacted Provider profile snapshot, Adapter/serializer versions, retry policy, revision, context window and independently resolved output-token capability. The pinned pi-ai catalog supplies exact built-in protocol/capability facts; custom routes use their redacted profile. |
| Harness | Complete system prompt, six exact tools, Agent Loop/options, context policy, Seatbelt policy and versions enter one JCS fingerprint. |
| Session | A fresh unpublished Agent/session is checked for `firstLiveSeq=0`, no replay seed/history, idle identity, and exactly the pinned `sandbox/mode=read-only` plus `approval/policy=never` bootstrap controls, then destroyed. No Provider request is sent. |
| Filesystem | Rust helper rejects symlink, hardlink, mount/device and special files using fd-relative no-follow traversal. |
| Execution | deny-default Seatbelt hostile probe covers sibling reads, shared temp, secret environment, loopback network and background orphan. |
| Control capacity | Fixed files are physically allocated with `F_PREALLOCATE`, fsynced, and tested through both checksum-protected generations. |
| Recovery | STARTING publication, execution unknown window, every FINALIZING stage, stale Seal and pending Delete converge after restart. |

The running Host writes the authoritative machine report to `$DSH_HOME/model-pk/v1/control/compatibility-report.json`. Any failed proof sets `executionEnabled=false`; Draft, diagnostics and storage views remain available while Start stays blocked.

## Local build evidence

The repository gate is:

```bash
pnpm check
```

It runs strict TypeScript checking, Vitest suites and both Host/Client production builds. Native tests use the compiled Rust binary and include deterministic snapshot/materialization, JCS tree identity, traversal rejection, fencing, capacity generations and macOS Seatbelt isolation.

## Release matrix still enforced dynamically

- Each release runner builds and hashes its own `darwin-arm64` or `darwin-x64` optional package.
- Real DeepSeek/pi-ai Provider fixtures are recorded separately from Fake Adapter failure injection.
- pi-ai routes without an observable supported protocol remain BLOCKED.
- Image experiments remain BLOCKED unless the selected models, DSH attachment limits and byte-for-byte readback contract all pass.

## Verified local host

On 2026-08-18 the exact DSH commit above completed every dynamic probe as
`PASS` on macOS arm64, including the hostile orphan and capacity-slot probes;
the resulting report set `executionEnabled=true`. A browser-driven integration
then started a two-model Experiment through the real DSH Agent path, settled
both credential-failure Attempts, produced `CURRENT / COMPLETE` self-contained
archives and an immutable Seal, restored the settled projection after a Host
restart, and completed durable deletion while retaining only a content-free
receipt. A `/var` to `/private/var` canonicalization regression found during
that run is covered by the native archive test. The x64 artifact is built and
tested by the release matrix on an x64 runner rather than inferred from arm64.
