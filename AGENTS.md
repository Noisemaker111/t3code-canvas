# AGENTS.md

Rules for the standalone T3 Code app source.

## Bootstrap

- Run `pnpm install --frozen-lockfile` when `node_modules` is missing.

## Verification

- Scope local runs to what you changed. CI owns the full suite.
- Focused tests: `vp test run <test-files>`, or a package's own `test`,
  `typecheck`, or `lint` script.
- Backend changes ship focused tests for the changed behavior.
- Frontend changes: boot a local client only for UI you changed, then use the
  [`test-t3-app`](.claude/skills/test-t3-app/SKILL.md) or
  [`test-t3-mobile`](.claude/skills/test-t3-mobile/SKILL.md) skill. Stop dev
  servers when you finish. Subagents do not launch their own.

## Vendored repos (`.repos/`)

Read-only reference source. Prefer its patterns over guesses or web search.
Never edit it. Never import from it. Sync with `vpr sync:repos` (`--repo <id>`
for one), in the same change that bumps the matching dependency.

- Effect code: read `.repos/effect-smol/LLMS.md` first.
- Relay code with Alchemy: read `.repos/alchemy-effect/`.

Package roles and reference links: [`docs/architecture/overview.md`](docs/architecture/overview.md).
