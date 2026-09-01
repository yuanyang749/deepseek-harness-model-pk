# Security

## Supported versions

Security fixes are provided for the latest published version of Model PK.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting for this repository. Include the affected version,
platform, reproduction steps, and sanitized diagnostics. Do not include API
keys, provider credentials, private prompts, or experiment artifacts.

## Security boundary

Model PK runs third-party model output and project commands inside a native
workspace sandbox. The sandbox restricts file access to the current Attempt
workspace, provides a private HOME and temporary directory, permits outbound
network access, and terminates the Attempt process tree. It does not make an
untrusted model provider trustworthy and cannot prevent data included in the
task package from being sent to the selected provider.

The compatibility gate must pass before execution is enabled. Keep DSH and the
plugin on the versions documented in README.md, review provider configuration,
and never include secrets in prompts, attachments, or baseline workspaces.
