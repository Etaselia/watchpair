# Contributing to WatchPair

## Setup

Use Node.js 24 and install dependencies with `npm ci`. The install configures the tracked hooks in `.githooks`; run `npm run hooks:install` if hooks were skipped.

## Before opening a pull request

Run:

```bash
npm run check
npm test
npm run test:desktop:e2e
npm run test:room:e2e
docker build -t watchpair:test .
npm audit --omit=dev
npx --yes pnpm@10.34.5 --dir companion audit --prod
```

The pre-commit hook runs lint, type checking, and the fast unit suite. The pre-push hook runs the production build and all integration tests. CI repeats both, exercises development and packaged Electron clients on Windows and Linux, and verifies the production Docker image.

Audit both lockfiles: desktop builds use the root npm tree, while the portable companion ZIP
ships `companion/pnpm-lock.yaml`. Use the companion's pinned pnpm version when refreshing it
so its `ip` security override is preserved. CI checks both production dependency trees.

As of 2026-10-22, the full root audit also reports two upstream advisories without published
patched versions: [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) in build/lint glob
processing and [sprintf-js](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) in Electron's
build-time download/proxy logging. These propagate to multiple development dependencies;
they are not present in the companion production dependency audit. Do not use `npm audit fix
--force` to resolve them: its proposed downgrades cross supported framework/builder versions.
Recheck upstream fixes during dependency maintenance and review any change that exposes these
tools to untrusted patterns or format strings.

## Commits and releases

Use Conventional Commit subjects so release notes and semantic versions remain useful:

- `fix:` for bug fixes
- `feat:` for features
- `feat!:` or a `BREAKING CHANGE:` footer for breaking changes
- `docs:`, `test:`, `build:`, and `chore:` for non-release maintenance

Changes enter `main` through squash-merged pull requests after the required checks pass. Release Please maintains a release pull request. Merging that pull request creates the GitHub release, publishes Windows and Linux companion installers plus updater metadata, retains the transitional ZIP, and pushes multi-platform images to GHCR. Major and minor releases are deployed during the 04:07 Europe/Vienna maintenance window; an explicitly approved `Deploy VPS` workflow dispatch can deploy a released version earlier.
