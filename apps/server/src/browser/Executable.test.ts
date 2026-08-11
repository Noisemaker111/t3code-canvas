import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveChromiumExecutable } from "./Executable.ts";

const makeTempExecutable = Effect.fn(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-executable-" });
  const executable = join(baseDir, name);
  yield* fs.writeFileString(executable, "#!/bin/sh\n");
  return { baseDir, executable };
});

it.layer(NodeServices.layer, { excludeTestServices: true })("resolveChromiumExecutable", (it) => {
  it.effect("explicit T3CODE_BROWSER_EXECUTABLE wins", () =>
    Effect.gen(function* () {
      const { executable } = yield* makeTempExecutable("chromium");
      const resolved = yield* resolveChromiumExecutable(
        { T3CODE_BROWSER_EXECUTABLE: executable },
        { browsersDirs: [], executables: [] },
      );
      assert.equal(resolved, executable);
    }),
  );

  it.effect("explicit executable that is missing fails without probing", () =>
    Effect.gen(function* () {
      const { executable } = yield* makeTempExecutable("real");
      const error = yield* Effect.flip(
        resolveChromiumExecutable(
          { T3CODE_BROWSER_EXECUTABLE: "/does/not/exist" },
          { browsersDirs: [], executables: [executable] },
        ),
      );
      assert.equal(error._tag, "AgentBrowserUnavailableError");
      assert.include(error.reason, "/does/not/exist");
    }),
  );

  it.effect("probes a browsers dir for the newest chromium build", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-browsers-" });
      const chrome = join(baseDir, "chromium-1200", "chrome-linux", "chrome");
      yield* fs.makeDirectory(join(baseDir, "chromium-1200", "chrome-linux"), { recursive: true });
      yield* fs.writeFileString(chrome, "#!/bin/sh\n");
      const resolved = yield* resolveChromiumExecutable(
        {},
        { browsersDirs: [baseDir], executables: [] },
      );
      assert.equal(resolved, chrome);
    }),
  );

  it.effect("probes system executables when no browsers dir matches", () =>
    Effect.gen(function* () {
      const { executable } = yield* makeTempExecutable("google-chrome");
      const resolved = yield* resolveChromiumExecutable(
        {},
        { browsersDirs: ["/nonexistent-browsers-dir"], executables: [executable] },
      );
      assert.equal(resolved, executable);
    }),
  );

  it.effect("lists the probed locations when nothing is found", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        resolveChromiumExecutable(
          {},
          { browsersDirs: ["/nowhere/browsers"], executables: ["/nowhere/chromium"] },
        ),
      );
      assert.equal(error._tag, "AgentBrowserUnavailableError");
      assert.include(error.reason, "/nowhere/browsers");
      assert.include(error.reason, "/nowhere/chromium");
    }),
  );
});
