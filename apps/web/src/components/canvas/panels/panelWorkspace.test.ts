import { describe, expect, it } from "@effect/vitest";

import { parseStationKey, stationKey } from "./panelStations";
import { editorEntityId, parseWorkspaceFileRef, workspaceFileLabel } from "./panelWorkspace";

describe("editorEntityId", () => {
  it("round-trips a project and a path", () => {
    const entityId = editorEntityId({ projectId: "prj_1", relativePath: "src/a/b.ts" });
    expect(parseWorkspaceFileRef(entityId)).toEqual({
      projectId: "prj_1",
      relativePath: "src/a/b.ts",
    });
  });

  // A station key splits on its first colon, so an editor address survives the
  // trip through `?station=` and back.
  it("survives a station key", () => {
    const ref = { kind: "editor", entityId: "prj_1:src/a/b.ts" } as const;
    expect(parseStationKey(stationKey(ref))).toEqual(ref);
  });

  it("reads a bare path as the primary project", () => {
    expect(parseWorkspaceFileRef("README.md")).toEqual({
      projectId: "",
      relativePath: "README.md",
    });
  });
});

describe("workspaceFileLabel", () => {
  it("titles the panel with the file, not the path to it", () => {
    expect(workspaceFileLabel("prj_1:apps/web/src/main.tsx")).toBe("main.tsx");
  });

  it("says what an editor with no file open is", () => {
    expect(workspaceFileLabel("prj_1:")).toBe("Editor");
  });
});
