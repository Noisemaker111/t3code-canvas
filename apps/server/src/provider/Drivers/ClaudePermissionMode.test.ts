import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { HostProcessUserId, resolveClaudePermissionMode } from "./ClaudePermissionMode.ts";

const asUser = (uid: number | undefined) => Effect.provideService(HostProcessUserId, { uid });

describe("resolveClaudePermissionMode", () => {
  it.effect("maps auto-accept-edits to acceptEdits", () =>
    Effect.gen(function* () {
      expect(yield* resolveClaudePermissionMode("auto-accept-edits", {}).pipe(asUser(0))).toEqual({
        permissionMode: "acceptEdits",
      });
    }),
  );

  it.effect("leaves approval-required without an SDK permission mode", () =>
    Effect.gen(function* () {
      expect(yield* resolveClaudePermissionMode("approval-required", {}).pipe(asUser(0))).toEqual({
        permissionMode: undefined,
      });
    }),
  );

  it.effect("keeps bypassPermissions for a non-root server process", () =>
    Effect.gen(function* () {
      expect(yield* resolveClaudePermissionMode("full-access", {}).pipe(asUser(1000))).toEqual({
        permissionMode: "bypassPermissions",
      });
    }),
  );

  it.effect("keeps bypassPermissions when there is no uid (Windows)", () =>
    Effect.gen(function* () {
      expect(yield* resolveClaudePermissionMode("full-access", {}).pipe(asUser(undefined))).toEqual(
        {
          permissionMode: "bypassPermissions",
        },
      );
    }),
  );

  it.effect("downgrades full-access to acceptEdits when running as root", () =>
    Effect.gen(function* () {
      expect(yield* resolveClaudePermissionMode("full-access", {}).pipe(asUser(0))).toEqual({
        permissionMode: "acceptEdits",
        downgradedFrom: "bypassPermissions",
      });
    }),
  );

  it.effect("honours IS_SANDBOX as root because the CLI check is opted out", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudePermissionMode("full-access", { IS_SANDBOX: "1" }).pipe(asUser(0)),
      ).toEqual({ permissionMode: "bypassPermissions" });
    }),
  );

  it.effect("ignores falsy IS_SANDBOX values as root", () =>
    Effect.gen(function* () {
      for (const value of ["", "  ", "0", "false"]) {
        expect(
          yield* resolveClaudePermissionMode("full-access", { IS_SANDBOX: value }).pipe(asUser(0)),
        ).toEqual({ permissionMode: "acceptEdits", downgradedFrom: "bypassPermissions" });
      }
    }),
  );
});
