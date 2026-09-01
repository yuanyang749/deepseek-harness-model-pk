# Contributing

## Development setup

Requirements are Node.js 22.19 or newer, pnpm 10.33.3, Rust stable, and a
supported macOS or Windows host.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build:native
pnpm check
```

## Pull requests

- Keep changes focused and preserve the frozen experiment and isolation rules.
- Add a failing test before changing behavior, then make it pass.
- Run `pnpm check` and the native Rust tests before opening a pull request.
- Do not commit credentials, local experiment data, generated packages, or
  native binaries.
- Document user-visible changes in README.md and CHANGELOG.md.

Native isolation changes must pass the four-runner GitHub Actions matrix:
macOS arm64, macOS x64, Windows x64, and Windows arm64.
