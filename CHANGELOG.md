# Changelog

All notable changes to this project are documented in this file.

## 0.1.3 - 2026-09-03

- Accept compatible DSH runtimes without requiring an exact package version or source commit.
- Record the actual DSH runtime in diagnostics, Harness fingerprints, experiment archives, and the UI while retaining capability-based execution checks.

## 0.1.2 - 2026-09-01

- Fix Cordis patch plugin bundle name registration to match package scope `@yuanyang749/dsh-model-pk`.
- Redesign creation form footer action layout to place "Clear and refil" beside primary button.

## 0.1.1 - 2026-09-01

- Preserve native helper execute permissions in npm installs by declaring platform package binaries.

## 0.1.0 - 2026-09-01

- Initial public release for DeepSeek Harness 0.1.1-rc.2.
- Run the same frozen task package across 2–10 configured models.
- Support text, image attachments, and isolated multi-file workspaces.
- Preserve experiment, run, attempt, retry, recovery, and archive evidence.
- Compare text or project outputs and export a user-ranked PNG experiment report.
- Ship native sandbox helpers for macOS and Windows on arm64 and x64.
