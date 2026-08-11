import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  MandatedSkillError,
  mandatedSkillNames,
  populateMandatedSkills,
} from "./mandatedSkills.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mandated-skills-" });
  const repositoryRoot = path.join(root, "repository");
  const sessionRoot = path.join(root, "session");
  const skillRoot = path.join(repositoryRoot, ".agents", "skills", "test-t3-app");
  yield* fs.makeDirectory(skillRoot, { recursive: true });
  yield* fs.makeDirectory(sessionRoot, { recursive: true });
  yield* fs.writeFileString(
    path.join(repositoryRoot, "AGENTS.md"),
    "Use the `test-t3-app` skill.\n",
  );
  yield* fs.writeFileString(path.join(skillRoot, "SKILL.md"), "# Test T3 App\n");
  return { repositoryRoot, sessionRoot };
});

it.layer(NodeServices.layer)("mandated repository skills", (it) => {
  it.effect("copies declared skills into the session skill home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* fixture;

      assert.deepEqual([...(yield* mandatedSkillNames(input.repositoryRoot))], ["test-t3-app"]);
      assert.deepEqual([...(yield* populateMandatedSkills(input))], ["test-t3-app"]);

      const copied = yield* fs.readFileString(
        path.join(input.sessionRoot, ".agents", "skills", "test-t3-app", "SKILL.md"),
      );
      assert.include(copied, "# Test T3 App");

      // .claude/skills is a link to the one copy, not a second one.
      const link = yield* fs.readLink(path.join(input.sessionRoot, ".claude", "skills"));
      assert.equal(
        path.resolve(input.sessionRoot, ".claude", link),
        path.join(input.sessionRoot, ".agents", "skills"),
      );
    }),
  );

  it.effect("fails closed when a declared skill is absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* fixture;
      yield* fs.remove(path.join(input.repositoryRoot, ".agents"), { recursive: true });

      const failure = yield* populateMandatedSkills(input).pipe(Effect.flip);
      assert.instanceOf(failure, MandatedSkillError);
      assert.match(failure.message, /repository-mandated test-t3-app skill is not installed/);
    }),
  );

  it.effect("installs a skill nested under vendor when only the nested AGENTS.md mandates it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mandated-nested-only-" });
      const repositoryRoot = path.join(root, "repository");
      const sessionRoot = path.join(root, "session");
      const vendor = path.join(repositoryRoot, "vendor", "foo");
      const skillRoot = path.join(vendor, ".agents", "skills", "test-t3-app");
      yield* fs.makeDirectory(skillRoot, { recursive: true });
      yield* fs.makeDirectory(sessionRoot, { recursive: true });
      yield* fs.writeFileString(path.join(repositoryRoot, "README.md"), "empty monorepo root\n");
      yield* fs.writeFileString(path.join(vendor, "AGENTS.md"), "Use the `test-t3-app` skill.\n");
      yield* fs.writeFileString(path.join(skillRoot, "SKILL.md"), "# Nested vendor skill\n");

      assert.deepEqual([...(yield* mandatedSkillNames(repositoryRoot))], ["test-t3-app"]);
      assert.deepEqual(
        [...(yield* populateMandatedSkills({ repositoryRoot, sessionRoot }))],
        ["test-t3-app"],
      );
      const copied = yield* fs.readFileString(
        path.join(sessionRoot, ".agents", "skills", "test-t3-app", "SKILL.md"),
      );
      assert.include(copied, "# Nested vendor skill");
    }),
  );

  it.effect("installs a nested skill when the monorepo root mandates it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mandated-root-nested-" });
      const repositoryRoot = path.join(root, "repository");
      const sessionRoot = path.join(root, "session");
      const skillRoot = path.join(
        repositoryRoot,
        "vendor",
        "t3code",
        ".agents",
        "skills",
        "test-t3-app",
      );
      yield* fs.makeDirectory(skillRoot, { recursive: true });
      yield* fs.makeDirectory(sessionRoot, { recursive: true });
      yield* fs.writeFileString(
        path.join(repositoryRoot, "AGENTS.md"),
        "Use the `test-t3-app` skill.\n",
      );
      yield* fs.writeFileString(path.join(skillRoot, "SKILL.md"), "# Vendor nested skill\n");

      assert.deepEqual(
        [...(yield* populateMandatedSkills({ repositoryRoot, sessionRoot }))],
        ["test-t3-app"],
      );
      const copied = yield* fs.readFileString(
        path.join(sessionRoot, ".agents", "skills", "test-t3-app", "SKILL.md"),
      );
      assert.include(copied, "# Vendor nested skill");
    }),
  );

  it.effect("prefers the shallowest skill when several copies exist under the repo", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mandated-shallow-" });
      const repositoryRoot = path.join(root, "repository");
      const sessionRoot = path.join(root, "session");
      const shallow = path.join(repositoryRoot, ".agents", "skills", "test-t3-app");
      const deep = path.join(repositoryRoot, "vendor", "other", ".agents", "skills", "test-t3-app");
      yield* fs.makeDirectory(shallow, { recursive: true });
      yield* fs.makeDirectory(deep, { recursive: true });
      yield* fs.makeDirectory(sessionRoot, { recursive: true });
      yield* fs.writeFileString(
        path.join(repositoryRoot, "AGENTS.md"),
        "Use the `test-t3-app` skill.\n",
      );
      yield* fs.writeFileString(path.join(shallow, "SKILL.md"), "# Shallow\n");
      yield* fs.writeFileString(path.join(deep, "SKILL.md"), "# Deep\n");

      yield* populateMandatedSkills({ repositoryRoot, sessionRoot });
      const copied = yield* fs.readFileString(
        path.join(sessionRoot, ".agents", "skills", "test-t3-app", "SKILL.md"),
      );
      assert.include(copied, "# Shallow");
    }),
  );
});

describe("mandatedSkillNames", () => {
  it.effect("reads no declarations from an empty repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mandated-empty-" });
      assert.deepEqual([...(yield* mandatedSkillNames(root))], []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("skips .pnpm-store and dangling entries instead of aborting the scan", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mandated-pnpm-" });
      yield* fs.writeFileString(path.join(root, "CLAUDE.md"), "Use the `ship` skill.\n");
      // A store full of broken project links must not fail the whole scan.
      const store = path.join(root, ".pnpm-store", "v11", "projects", "dead");
      yield* fs.makeDirectory(store, { recursive: true });
      yield* fs.writeFileString(path.join(store, "CLAUDE.md"), "Use the `ignore-me` skill.\n");
      assert.deepEqual([...(yield* mandatedSkillNames(root))], ["ship"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
