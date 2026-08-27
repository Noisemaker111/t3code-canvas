# T3 Code Canvas

**T3 Code Canvas** is a public fork of [T3 Code](https://github.com/pingdotgg/t3code)
that makes the web workspace a persistent, spatial canvas. It keeps T3 Code's
provider/session server and React client, while putting the board,
conversations, tools, and project views together on one tldraw canvas.

## Canvas fork

Unlike normal upstream T3 Code's screen-first workflow, Canvas provides:

- movable, resizable, closable panels with zoom-aware summaries and persisted
  canvas state;
- a Kanban frame whose columns are independently addable, renameable, and
  removable components, with the composer in the same frame;
- **Add** and context-menu actions for components and the shipped **Kanban**,
  **Agents**, and **IDE** frames;
- canvas panels for agent threads, terminals, browsers, explorer/editor, Git,
  pull requests, issues, Settings, and Hermes. Live shells and browser tabs
  remain attached to their thread when a panel moves or closes; and
- a compact narrow-screen layout that lets a phone navigate the board one
  column at a time.

Canvas-specific implementation lives in `apps/web/src/components/canvas/`.
The canvas image tools use the server's `/api/canvas/image/*` endpoints.

The fork keeps the upstream monorepo shape and compatibility foundations:
`apps/server` remains the Node WebSocket server and `t3` CLI, `apps/web` remains
the React/Vite client, and `packages/contracts`, `packages/shared`, and
`packages/client-runtime` remain the shared protocol/runtime layers. Canvas
changes the spatial presentation; it does not replace the provider-session
server or its CLI packaging.

This fork is [`Noisemaker111/t3code-canvas`](https://github.com/Noisemaker111/t3code-canvas),
and the original is [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code).
The [fork journey and app boundary](https://github.com/Noisemaker111/vps-code/blob/main/docs/T3CODE-CANVAS-MIGRATION.md)
explain the split from the VPS repository. The [fork commit history](https://github.com/Noisemaker111/t3code-canvas/commits/main)
is the current changelog; compare it with [upstream's history](https://github.com/pingdotgg/t3code/commits/main).

## Current status

At the current `main` checkout, the application version is `0.0.28`. The
publishable package is `t3` from
`apps/server`; this repository is the application fork, not the VPS host
configuration. This README was verified against that commit.

## Quick start and development

Requirements: Node `^24.13.1` and pnpm `11.10.0` (the versions declared by the
workspace).

```bash
git clone https://github.com/Noisemaker111/t3code-canvas.git
cd t3code-canvas
pnpm install --frozen-lockfile
pnpm run dev
```

The dev runner prints a local pairing URL. On Windows, use the printed
`127.0.0.1` origin rather than changing it to `localhost`; authentication and
server state are origin-scoped. Workspace commands are in
[`package.json`](./package.json), including `dev`, `build`, `test`,
`typecheck`, and `lint`.

## Production build, package, and server

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm --filter t3 start
```

The build produces the server bundle in `apps/server/dist/` and the web output
in `apps/web/dist/`. The server package's downloadable/publishable artifact is
`apps/server/dist/`; its package metadata includes that directory and the
bundle contains the required web client. To create the npm package artifact:

```bash
pnpm --filter t3 publish --no-git-checks
```

`pnpm --filter t3 start` runs `apps/server/dist/bin.mjs`. A production server
requires `apps/web/dist/index.html`; `T3CODE_STATIC_DIR` may instead point at a
separately installed web bundle.

For the VPS-hosted deployment, see the separate
[`Noisemaker111/vps-code`](https://github.com/Noisemaker111/vps-code) repository.

## Documentation and license

- [Getting started](./docs/getting-started/quick-start.md)
- [Architecture overview](./docs/architecture/overview.md)
- [Provider guides](./docs/providers/codex.md)
- [Operations](./docs/operations/ci.md)
- [Reference](./docs/reference/encyclopedia.md)
- [Contributing](./CONTRIBUTING.md)

MIT licensed; see [`LICENSE`](./LICENSE).
