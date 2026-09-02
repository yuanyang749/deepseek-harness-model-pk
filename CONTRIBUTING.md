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

## Release

Do not publish native packages from a single developer machine. Push a version
tag and let the `release` workflow build all four platform packages, publish
them with the main package to npm, and create a GitHub Release.

```bash
pnpm bump patch
# update CHANGELOG.md, then:
git add -A
git commit -m "release: v0.1.3"
git tag v0.1.3
git push origin main --tags
```

Manual `workflow_dispatch` on `release` only uploads artifacts unless the
`publish` input is enabled. The publish job needs repository secret `NPM_TOKEN`
with publish access to `@yuanyang749/*`.
