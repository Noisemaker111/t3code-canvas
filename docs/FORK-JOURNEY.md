# Fork journey: T3 Code to t3code-canvas

This document records the repository boundary as it exists on **2026-08-27**.
For how to install, run, and build the application, start with the
[repository README](../README.md). This is a history and maintenance note, not
a replacement for that guide.

## Where the code came from

The upstream project is [T3 Code](https://github.com/pingdotgg/t3code). The
private deployment repository, [Noisemaker111/vps-code](https://github.com/Noisemaker111/vps-code),
originally carried the application under `vendor/t3code` as part of the VPS
checkout. The parent repository's README names `pingdotgg/t3code` as the
upstream, and its `scripts/sync-t3-upstream.sh` fetches that repository's
`main` branch before merging it in the application repository.

The upstream relationship is provenance, not a claim that this repository's
current branch preserves upstream commits as ancestors. The current
`t3code-canvas` `main` history starts with Noisemaker111's `Initial commit`
(`9c74506`, 2026-08-05), followed by an imported workspace
(`0da5a33`, 2026-08-27). In other words, the imported tree is a snapshot with
Noisemaker history around it; use the upstream link and the sync procedure
above when tracing or bringing in upstream changes.

The standalone checkout's configured `origin` fetch and push URLs are
`https://github.com/Noisemaker111/t3code-canvas.git`. The parent checkout's
`origin` is `https://github.com/Noisemaker111/vps-code`; upstream is fetched
explicitly by URL by the parent sync script rather than being this checkout's
`origin`.

## Milestones recorded in git

The dates below are commit dates from the repositories, not inferred release
dates.

| Date                         | Repository and commit                                                                                                                                                                                                                                                                                                             | What it records                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-08-05 04:08 UTC         | `vps-code` [`b11e9bf`](https://github.com/Noisemaker111/vps-code/commit/b11e9bf07161803bb9fae2418f43a8086c105c93)                                                                                                                                                                                                                 | The application was split out of the private devbox and made a public submodule. The commit explicitly excludes private reference clones and state dumps.                                  |
| 2026-08-05 04:14 UTC         | `vps-code` [`1b5add2`](https://github.com/Noisemaker111/vps-code/commit/1b5add26d7682029f0aaeb97483aa164049217dc)                                                                                                                                                                                                                 | The public app repository was named `t3code-canvas`; the submodule URL became this repository.                                                                                             |
| 2026-08-05 04:16 UTC         | `vps-code` [`cd32396`](https://github.com/Noisemaker111/vps-code/commit/cd323967ea30223bcfbd7bd712dda3c6fca73031)                                                                                                                                                                                                                 | The parent pinned the published import commit as a gitlink.                                                                                                                                |
| 2026-08-11 00:36–02:57 -0400 | `t3code-canvas` [`28db323`](https://github.com/Noisemaker111/t3code-canvas/commit/28db323d9eac17d3326b5bb9d0fb00f8f7b86059) through [`0920dbc`](https://github.com/Noisemaker111/t3code-canvas/commit/0920dbc)                                                                                                                    | A Noisemaker111 sync from `vps-code` was prepared as standalone public source, followed by CI, typing, and test portability fixes. These are fork-owner changes, not upstream commits.     |
| 2026-08-27 15:10–15:56 -0400 | `vps-code` [`35a36b8`](https://github.com/Noisemaker111/vps-code/commit/35a36b88ab0e0ee289a00bc98bc5efd9f4537f00), [`9112bb6`](https://github.com/Noisemaker111/vps-code/commit/9112bb634d2a458c018834867c5e55a8687ae0ab), [`73c0eeb`](https://github.com/Noisemaker111/vps-code/commit/73c0eeba8723147caa5a4b461f23dbb568daba14) | The migration was made explicit and safe: the app became a complete standalone submodule, release builds materialize it from its own HEAD, and the migration handoff was documented.       |
| 2026-08-27 15:45 -0400       | `t3code-canvas` [`0da5a33`](https://github.com/Noisemaker111/t3code-canvas/commit/0da5a33)                                                                                                                                                                                                                                        | The current public `main` line imported the T3 Code canvas workspace. Subsequent commits on this line are Noisemaker111 changes, including Windows portability and the Claude Code bridge. |
| 2026-08-27 17:00 -0400       | `t3code-canvas` [`a242f5b`](https://github.com/Noisemaker111/t3code-canvas/commit/a242f5becccd5eb82059fa084e16af36e48c9ea7)                                                                                                                                                                                                       | The completed bridge work claim was cleared.                                                                                                                                               |
| 2026-08-27 17:24–17:27 -0400 | `t3code-canvas` [`52a5f42`](https://github.com/Noisemaker111/t3code-canvas/commit/52a5f42c6f9ba7271711731e55e61bedcb0e09b8)                                                                                                                                                                                                       | The public README and this fork journey were published, with current package status clarified.                                                                                             |

The 2026-08-27 fork-owner commits changed more than a directory name: they
made this workspace independently buildable and releasable, kept the web
client with the server package, added Windows-portable validation, and added
the Claude Code CLI bridge. Those descriptions come from the commit messages;
they should not be attributed to `pingdotgg/t3code`.

## Why the canvas left `vps-code`

`vps-code` is the private operational layer: VPS configuration, deployment,
systemd units, and the host that serves the site. The canvas application is a
reusable public codebase with its own package, CI, release history, and
upstream-sync boundary. Keeping the application in a public repository avoids
publishing private VPS material while allowing the parent to consume a tested,
versioned application commit.

The transition also fixed a real git/worktree distinction: a submodule is a
gitlink, not an expanded directory in every parent worktree. The parent release
builder therefore initializes `vendor/t3code` inside the release worktree and
reads the application version from that checkout's own `HEAD`.

## How the two repositories relate now

At the documented snapshot, `vps-code`'s `vendor/t3code` gitlink points to
`52a5f42` (the public repository's `main` commit). The parent records only that
40-character application commit; it does not contain the application's files
in its own tree. A standalone checkout of `t3code-canvas` is the source for the
application. A checkout of `vps-code` needs
`git submodule update --init --recursive` to materialize the same application.

The repositories are therefore updated in two steps: commit and publish the
application change here, then update the `vendor/t3code` gitlink in
`vps-code`. Do not edit application source in the parent and expect that edit
to become a standalone release.

## Maintenance and releases

1. Work on application code and docs in this repository. Keep private VPS
   configuration and deployment changes in `vps-code`.
2. To synchronize upstream, use the parent repository's
   `scripts/sync-t3-upstream.sh`. It requires a clean tree, initializes the
   submodule, fetches `https://github.com/pingdotgg/t3code.git` `main`, and
   merges it here. Review the merge for fork-specific behavior; do not label
   the resulting changes as upstream without checking the commits.
3. Push the resulting `t3code-canvas` commit, then bump the parent gitlink and
   run the parent release checks. The parent migration note documents the
   release path in [`vps-code/docs/T3CODE-CANVAS-MIGRATION.md`](https://github.com/Noisemaker111/vps-code/blob/main/docs/T3CODE-CANVAS-MIGRATION.md).
4. For a standalone package build, follow the README and the existing release
   scripts. The parent records the exact tested app commit, so releases should
   never depend on an uncommitted submodule working tree.

When history is ambiguous, inspect both logs: `git log` here identifies
fork-owner and imported-workspace commits, while `git log` in `vps-code`
identifies the gitlink and deployment-boundary changes. The upstream repository
is the authority for upstream history; this file deliberately does not invent
an upstream SHA for the imported snapshot.
