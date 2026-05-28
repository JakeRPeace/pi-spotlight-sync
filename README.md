# pi-spotlight-sync

A [pi](https://pi.dev/) extension that mirrors changes from the current linked Git worktree into the base repository root so tools that only work from one root can run against your active pi changes.

## Install

```bash
pi install npm:pi-spotlight-sync
```

For the GitHub version:

```bash
pi install git:github.com/JakeRPeace/pi-spotlight-sync@main
```

## Commands

```bash
/beam on [base-root-path] [--interval=1500] [--base=origin/main]
/beam update [base-root-path] [--base=origin/main]
/beam status [base-root-path]
/beam off [base-root-path]
```

Aliases:

- `/spotlight` is the full command name.
- `/beaming` is shorthand for `/beam status`.

## What it shows

The footer status shows:

- tracked file changes that differ from `HEAD`
- commits ahead of the configured base ref, defaulting to `origin/main`
- when the root was last synced

Example:

```text
🔦 beaming 3 files · 2 commits ahead · 5s ago
```

## Safety model

This extension is intentionally conservative, but it runs Git commands that change the destination worktree:

- The destination root defaults to the base repository root from `git rev-parse --git-common-dir`.
- The destination root is reset with `git reset --hard` and checked out at the source worktree `HEAD`.
- Tracked file changes from the source worktree are copied into the destination root.
- The extension refuses to start if the destination root has tracked changes and no active spotlight state exists.
- Running `/beam on` from another linked worktree switches the destination root to that worktree's state.
- Use `/beam off` from the active source worktree to restore the destination root to the branch and commit it had before spotlight sync started.

Untracked files in the destination root are not removed.

## Development

```bash
npm install
npm run typecheck
npm run pack:dry
pi -e .
```

## Publish

The pi package gallery lists npm packages with the `pi-package` keyword. Publish this package to npm and it will appear at `https://pi.dev/packages/pi-spotlight-sync` after the gallery indexes it.

```bash
npm login
npm publish
```

## License

MIT
