/**
 * Repository-mandated skills: an `AGENTS.md`/`CLAUDE.md` that tells an agent to
 * "use the `x` skill" is a requirement, so the skill is copied into the session
 * before the provider starts. A skill the repository names but nothing provides
 * fails the launch — an agent that silently lacks it does the work wrong.
 *
 * @module project/mandatedSkills
 */
import * as NodeOS from "node:os";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const DECLARATION_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);
// `.pnpm-store` is a content-addressable tree full of broken project links;
// walking it surfaces FileSystem.stat NotFound and aborts every launch that
// needs mandated skills (live failure: provider.turn.start.failed).
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".repos",
  ".pnpm-store",
  ".pnpm",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
  "worktrees",
]);
const SKILL_DECLARATION =
  /(?:use|run|launch|invoke)\s+(?:the\s+)?[`']([A-Za-z0-9][A-Za-z0-9._-]*)[`']\s+skill\b/gi;
const SKILL_MISSING = "repository-mandated";

/** A skill the repository mandates that this session cannot provide. */
export class MandatedSkillError extends Data.TaggedError("MandatedSkillError")<{
  readonly skill: string;
  readonly repositoryRoot: string;
  readonly sessionRoot: string;
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

/** The skill scan itself failed — the mandate is unknown, not empty. */
export class MandatedSkillScanError extends Data.TaggedError("MandatedSkillScanError")<{
  readonly path: string;
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

const declarationFilesUnder = (
  root: string,
): Effect.Effect<
  ReadonlyArray<string>,
  MandatedSkillScanError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const found: string[] = [];

    const visit = (directory: string): Effect.Effect<void, MandatedSkillScanError, never> =>
      Effect.gen(function* () {
        const entries = yield* fs.readDirectory(directory).pipe(
          Effect.mapError(
            (cause) =>
              new MandatedSkillScanError({
                path: directory,
                detail: `Could not read repository skill declarations under '${directory}': ${cause}`,
              }),
          ),
        );
        for (const entry of entries) {
          if (SKIPPED_DIRECTORIES.has(entry)) continue;
          const full = path.join(directory, entry);
          // Broken symlinks and mid-scan deletes are not a mandate failure —
          // skip the entry. Real I/O errors still surface.
          const info = yield* fs.stat(full).pipe(
            Effect.map((value) => value as { readonly type: string } | null),
            Effect.catchTag("PlatformError", (cause) => {
              if (cause.reason._tag === "NotFound") return Effect.succeed(null);
              return Effect.fail(
                new MandatedSkillScanError({
                  path: full,
                  detail: `Could not inspect '${full}' while scanning skill declarations: ${cause}`,
                }),
              );
            }),
            Effect.mapError(
              (cause) =>
                new MandatedSkillScanError({
                  path: full,
                  detail: `Could not inspect '${full}' while scanning skill declarations: ${cause}`,
                }),
            ),
          );
          if (info === null) continue;
          if (info.type === "Directory") yield* visit(full);
          else if (DECLARATION_FILES.has(entry)) found.push(full);
        }
      });

    yield* visit(root);
    return found;
  });

/** The skill names an `AGENTS.md`/`CLAUDE.md` anywhere under the repository declares. */
export const mandatedSkillNames = (
  repositoryRoot: string,
): Effect.Effect<
  ReadonlyArray<string>,
  MandatedSkillScanError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = new Set<string>();
    for (const file of yield* declarationFilesUnder(repositoryRoot)) {
      const text = yield* fs.readFileString(file).pipe(
        Effect.mapError(
          (cause) =>
            new MandatedSkillScanError({
              path: file,
              detail: `Could not read repository skill declaration '${file}': ${cause}`,
            }),
        ),
      );
      for (const match of text.matchAll(SKILL_DECLARATION)) {
        const name = match[1]?.trim().toLowerCase();
        if (name) names.add(name);
      }
    }
    return [...names].sort();
  });

const SKILL_HOME_SEGMENTS: ReadonlyArray<ReadonlyArray<string>> = [
  [".agents", "skills"],
  [".claude", "skills"],
  [".codex", "skills"],
  ["config", "codex", "skills"],
];

const skillRootsNear = (path: Path.Path, start: string, name: string): ReadonlyArray<string> => {
  const roots: string[] = [];
  let current = path.resolve(start);
  for (;;) {
    for (const segments of SKILL_HOME_SEGMENTS) {
      roots.push(path.join(current, ...segments, name));
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const home = NodeOS.homedir();
  roots.push(path.join(home, ".agents", "skills", name));
  roots.push(path.join(home, ".claude", "skills", name));
  roots.push(path.join(home, ".codex", "skills", name));
  return roots;
};

/** Depth of `candidate` under `root` (path segments after root). Lower is shallower. */
const depthUnder = (path: Path.Path, root: string, candidate: string): number => {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return Number.MAX_SAFE_INTEGER;
  return rel.split(/[/\\]/).filter(Boolean).length;
};

/**
 * Skill directories under the repository at any depth
 * (.agents/.claude/.codex/skills and config/codex/skills).
 * Shallowest wins so a monorepo-root skill beats a nested vendor copy.
 */
const skillRootsUnderRepository = (
  repositoryRoot: string,
  name: string,
): Effect.Effect<
  ReadonlyArray<string>,
  MandatedSkillScanError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const found: string[] = [];
    const skillMd = "SKILL.md";

    const visit = (directory: string): Effect.Effect<void, MandatedSkillScanError, never> =>
      Effect.gen(function* () {
        const entries = yield* fs.readDirectory(directory).pipe(
          Effect.mapError(
            (cause) =>
              new MandatedSkillScanError({
                path: directory,
                detail: `Could not search for skill '${name}' under '${directory}': ${cause}`,
              }),
          ),
        );
        for (const entry of entries) {
          if (SKIPPED_DIRECTORIES.has(entry)) continue;
          const full = path.join(directory, entry);
          const info = yield* fs.stat(full).pipe(
            Effect.map((value) => value as { readonly type: string } | null),
            Effect.catchTag("PlatformError", (cause) => {
              if (cause.reason._tag === "NotFound") return Effect.succeed(null);
              return Effect.fail(
                new MandatedSkillScanError({
                  path: full,
                  detail: `Could not inspect '${full}' while searching for skill '${name}': ${cause}`,
                }),
              );
            }),
            Effect.mapError(
              (cause) =>
                new MandatedSkillScanError({
                  path: full,
                  detail: `Could not inspect '${full}' while searching for skill '${name}': ${cause}`,
                }),
            ),
          );
          if (info === null) continue;
          if (info.type !== "Directory") continue;

          // Match .../<home>/skills/<name> where home is .agents|.claude|.codex
          // or config/codex/skills/<name>.
          const skillFile = path.join(full, name, skillMd);
          const parentBase = path.basename(full);
          const grandBase = path.basename(path.dirname(full));
          const isStandardSkills =
            parentBase === "skills" &&
            (grandBase === ".agents" || grandBase === ".claude" || grandBase === ".codex");
          const isConfigCodexSkills =
            parentBase === "skills" &&
            grandBase === "codex" &&
            path.basename(path.dirname(path.dirname(full))) === "config";

          if (isStandardSkills || isConfigCodexSkills) {
            const skillInfo = yield* fs.stat(skillFile).pipe(Effect.option);
            if (skillInfo._tag === "Some" && skillInfo.value.type === "File") {
              found.push(path.join(full, name));
            }
            // Skill package trees are not nested skill homes; do not descend.
            continue;
          }

          yield* visit(full);
        }
      });

    yield* visit(path.resolve(repositoryRoot));
    found.sort((a, b) => {
      const depthDelta = depthUnder(path, repositoryRoot, a) - depthUnder(path, repositoryRoot, b);
      if (depthDelta !== 0) return depthDelta;
      return a.localeCompare(b);
    });
    return found;
  });

const skillDirectory = (
  roots: ReadonlyArray<string>,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const root of roots) {
      const info = yield* fs.stat(path.join(root, "SKILL.md")).pipe(Effect.option);
      if (info._tag === "Some" && info.value.type === "File") return root;
    }
    return null;
  });

/** Resolve a mandated skill: shallowest under the repo, then parents/home. */
const resolveMandatedSkillSource = (
  repositoryRoot: string,
  name: string,
): Effect.Effect<string | null, MandatedSkillScanError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const underRepo = yield* skillRootsUnderRepository(repositoryRoot, name);
    if (underRepo.length > 0) return underRepo[0] ?? null;
    return yield* skillDirectory(skillRootsNear(path, repositoryRoot, name));
  });

/** Populate the agent-visible skill home, or fail before a provider session starts. */
export const populateMandatedSkills = (input: {
  readonly repositoryRoot: string;
  readonly sessionRoot: string;
}): Effect.Effect<
  ReadonlyArray<string>,
  MandatedSkillError | MandatedSkillScanError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* mandatedSkillNames(input.repositoryRoot);
    if (names.length === 0) return [];

    const failed = (skill: string, detail: string) =>
      new MandatedSkillError({
        skill,
        repositoryRoot: input.repositoryRoot,
        sessionRoot: input.sessionRoot,
        detail,
      });

    const destination = path.join(input.sessionRoot, ".agents", "skills");
    yield* fs
      .makeDirectory(destination, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          failed(
            names.join(","),
            `Could not create the session skill home '${destination}': ${cause}`,
          ),
        ),
      );

    const installed: string[] = [];
    for (const name of names) {
      const source = yield* resolveMandatedSkillSource(input.repositoryRoot, name);
      const target = path.join(destination, name);
      if (!source) {
        return yield* failed(
          name,
          `The ${SKILL_MISSING} ${name} skill is not installed in this session: ` +
            `repository '${input.repositoryRoot}' mandates it, but no SKILL.md was found ` +
            `in the repository or supported agent skill homes.`,
        );
      }
      if (path.resolve(source) !== path.resolve(target)) {
        yield* fs
          .remove(target, { recursive: true, force: true })
          .pipe(Effect.andThen(fs.copy(source, target)))
          .pipe(
            Effect.mapError((cause) =>
              failed(name, `Could not install the ${SKILL_MISSING} ${name} skill: ${cause}`),
            ),
          );
      }
      installed.push(name);
    }

    // Claude reads .claude/skills; the symlink keeps one copy on disk.
    const claudeSkills = path.join(input.sessionRoot, ".claude", "skills");
    yield* Effect.gen(function* () {
      if (yield* fs.exists(claudeSkills)) return;
      yield* fs.makeDirectory(path.dirname(claudeSkills), { recursive: true });
      yield* fs.symlink(path.relative(path.dirname(claudeSkills), destination), claudeSkills);
    }).pipe(
      Effect.mapError(() =>
        failed(
          installed.join(","),
          `The ${SKILL_MISSING} skills could not be made visible in session '${input.sessionRoot}'.`,
        ),
      ),
    );

    return installed;
  });
