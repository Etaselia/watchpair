# Contributing to WatchPair

## Setup

Use Node.js 24 and install dependencies with `npm ci`. The install configures the tracked hooks in `.githooks`; run `npm run hooks:install` if hooks were skipped.

## Before opening a pull request

Run:

```bash
npm run check
npm test
npm run test:desktop:e2e
docker build -t watchpair:test .
```

The pre-commit hook runs lint, type checking, and the fast unit suite. The pre-push hook runs the production build and all integration tests. CI repeats both, exercises development and packaged Electron clients on Windows and Linux, and verifies the production Docker image.

## Commits and releases

Use Conventional Commit subjects so release notes and semantic versions remain useful:

- `fix:` for bug fixes
- `feat:` for features
- `feat!:` or a `BREAKING CHANGE:` footer for breaking changes
- `docs:`, `test:`, `build:`, and `chore:` for non-release maintenance

Changes enter `main` through squash-merged pull requests after the required checks pass. Release Please maintains a release pull request. Merging that pull request creates the GitHub release, publishes Windows and Linux companion installers plus updater metadata, retains the transitional ZIP, and pushes multi-platform images to GHCR. Major and minor releases are deployed during the 04:07 Europe/Vienna maintenance window; an explicitly approved `Deploy VPS` workflow dispatch can deploy a released version earlier.
