# AGENTS.md

Outer [`vps-code/CLAUDE.md`](../../CLAUDE.md) wins. This file holds only what is
specific to the T3 Code app source.

## Verification

- Scope local runs to what you changed. The gate before pushing is
  `scripts/verify.sh --changed` in the outer repo. Do not run full-suite root
  scripts (`test`, `typecheck`, `lint`, `vp check`) by hand — CI owns the full
  suite.
- Focused tests: `vp test run <test-files>`, or a package's own `test` /
  `typecheck` / `lint` script.
- Backend changes ship focused tests for the changed behavior.
- Frontend changes: read the live board first (outer `CLAUDE.md`). Boot a local
  client only for UI you changed and have not deployed, then use the
  [`test-t3-app`](.claude/skills/test-t3-app/SKILL.md) or
  [`test-t3-mobile`](.claude/skills/test-t3-mobile/SKILL.md) skill. Stop dev
  servers when you finish. Subagents do not launch their own.

## Vendored repos (`.repos/`)

Read-only reference source. Prefer its patterns over guesses or web search.
Never edit it. Never import from it. Sync with `vpr sync:repos` (`--repo <id>`
for one), in the same change that bumps the matching dependency.

- Effect code → read `.repos/effect-smol/LLMS.md` first.
- Relay code with Alchemy → read `.repos/alchemy-effect/`.

Package roles and reference links:
outer [`README.md`](../../README.md#t3-code-app-source).
