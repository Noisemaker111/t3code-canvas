import { DEFAULT_BOARD_SETTINGS } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetBoardSettingsRemoteQueueForTests,
  applyServerBoardSettings,
  applyServerHermesBrainConfig,
  bindBoardSettingsServerPersist,
  flushRemotePersist,
  hydrateBoardSettingsFromServer,
  peekLocalBoardSettings,
  readBoardSettings,
  updateBoardSettings,
  writeBoardSettings,
} from "./boardSettings";

function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

describe("boardSettings server hydrate", () => {
  beforeEach(() => {
    __resetBoardSettingsRemoteQueueForTests();
    const storage = createStorage();
    vi.stubGlobal("window", {
      localStorage: storage,
      dispatchEvent: () => true,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal(
      "CustomEvent",
      class CustomEvent<T> {
        readonly detail: T | undefined;
        constructor(
          readonly type: string,
          init?: { detail?: T },
        ) {
          this.detail = init?.detail;
        }
      },
    );
  });

  afterEach(() => {
    bindBoardSettingsServerPersist(null);
    vi.unstubAllGlobals();
  });

  it("migrates non-default local prefs when server still has defaults", () => {
    const persisted: Array<unknown> = [];
    bindBoardSettingsServerPersist((next) => {
      persisted.push(next);
    });

    writeBoardSettings(
      {
        ...DEFAULT_BOARD_SETTINGS,
        hermesAutoMovePromptsToActive: true,
        showHermesChip: false,
      },
      { persistRemote: false },
    );

    const next = hydrateBoardSettingsFromServer(DEFAULT_BOARD_SETTINGS);
    flushRemotePersist();
    expect(next.hermesAutoMovePromptsToActive).toBe(true);
    expect(next.showHermesChip).toBe(false);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      hermesAutoMovePromptsToActive: true,
      showHermesChip: false,
    });
  });

  it("prefers server board settings when they differ from defaults", () => {
    writeBoardSettings(
      {
        ...DEFAULT_BOARD_SETTINGS,
      },
      { persistRemote: false },
    );

    const next = hydrateBoardSettingsFromServer({
      ...DEFAULT_BOARD_SETTINGS,
      hermesAutoMovePromptsToActive: false,
      showHermesChip: false,
    });

    expect(next.hermesAutoMovePromptsToActive).toBe(false);
    expect(next.showHermesChip).toBe(false);
    expect(peekLocalBoardSettings()?.showHermesChip).toBe(false);
  });

  it("dual-writes to the bound server persist callback on update", () => {
    const persisted: Array<unknown> = [];
    bindBoardSettingsServerPersist((next) => {
      persisted.push(next);
    });

    updateBoardSettings({ hermesBrainIntervalMs: 42_000 });
    flushRemotePersist();
    expect(readBoardSettings().hermesBrainIntervalMs).toBe(42_000);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ hermesBrainIntervalMs: 42_000 });
  });

  it("migrates a saved Hermes model from localStorage when server is defaults", () => {
    const persisted: Array<unknown> = [];
    bindBoardSettingsServerPersist((next) => {
      persisted.push(next);
    });

    writeBoardSettings(
      {
        ...DEFAULT_BOARD_SETTINGS,
        hermesInstanceId: "cursor",
        hermesModel: "grok-4.5",
      },
      { persistRemote: false },
    );

    const next = hydrateBoardSettingsFromServer(DEFAULT_BOARD_SETTINGS);
    flushRemotePersist();
    expect(next.hermesInstanceId).toBe("cursor");
    expect(next.hermesModel).toBe("grok-4.5");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      hermesInstanceId: "cursor",
      hermesModel: "grok-4.5",
    });
  });

  it("keeps a freshly added MCP server row that has no URL yet", () => {
    writeBoardSettings(
      {
        ...DEFAULT_BOARD_SETTINGS,
        hermesMcpServers: [{ name: "server1", url: "", headers: {}, enabled: true }],
      },
      { persistRemote: false },
    );

    expect(readBoardSettings().hermesMcpServers).toEqual([
      { name: "server1", url: "", headers: {}, enabled: true },
    ]);
  });

  it("drops an MCP server row whose name is not an identifier", () => {
    writeBoardSettings(
      {
        ...DEFAULT_BOARD_SETTINGS,
        hermesMcpServers: [
          { name: "1 bad name", url: "https://mcp.example/mcp", headers: {}, enabled: true },
        ],
      },
      { persistRemote: false },
    );

    expect(readBoardSettings().hermesMcpServers).toEqual([]);
  });

  it("keeps server Hermes model over a different local cache", () => {
    writeBoardSettings(
      {
        ...DEFAULT_BOARD_SETTINGS,
        hermesInstanceId: "codex",
        hermesModel: "gpt-5.4",
      },
      { persistRemote: false },
    );

    const next = hydrateBoardSettingsFromServer({
      ...DEFAULT_BOARD_SETTINGS,
      hermesInstanceId: "cursor",
      hermesModel: "grok-4.5",
    });

    expect(next.hermesInstanceId).toBe("cursor");
    expect(next.hermesModel).toBe("grok-4.5");
  });

  it("ships the brain on with no instance picked yet", () => {
    const settings = readBoardSettings();

    expect(settings.hermesBrainEnabled).toBe(true);
    expect(settings.hermesBrainInstanceId).toBeNull();
  });

  it("keeps the brain's instance pick as the same slug the picker sent", () => {
    writeBoardSettings(
      { ...DEFAULT_BOARD_SETTINGS, hermesBrainInstanceId: " opencode " },
      { persistRemote: false },
    );

    expect(readBoardSettings().hermesBrainInstanceId).toBe("opencode");
  });

  it("drops unknown tier names from a persisted chain", () => {
    writeBoardSettings(
      {
        ...DEFAULT_BOARD_SETTINGS,
        hermesBrainTierOrder: ["openrouter", "claude", "cursor"] as never,
      },
      { persistRemote: false },
    );

    expect(readBoardSettings().hermesBrainTierOrder).toEqual(["openrouter", "cursor"]);
  });

  it("takes the server's brain switch over the local cache", () => {
    writeBoardSettings({ ...DEFAULT_BOARD_SETTINGS }, { persistRemote: false });

    const next = hydrateBoardSettingsFromServer({
      ...DEFAULT_BOARD_SETTINGS,
      hermesBrainEnabled: true,
      hermesBrainDisabledTiers: ["cursor"],
    });

    expect(next.hermesBrainEnabled).toBe(true);
    expect(next.hermesBrainDisabledTiers).toEqual(["cursor"]);
  });

  it("folds a brain answer into the cache without posting the whole object back", () => {
    const persisted: Array<unknown> = [];
    writeBoardSettings(
      { ...DEFAULT_BOARD_SETTINGS, hermesBrainEnabled: false },
      { persistRemote: false },
    );
    bindBoardSettingsServerPersist((next) => {
      persisted.push(next);
    });

    const next = applyServerHermesBrainConfig({
      enabled: true,
      instanceId: "opencode",
      model: "openrouter/x-ai/grok-4.5",
      intervalMs: 30_000,
      maxNudges: 5,
    });

    expect(persisted).toEqual([]);
    expect(next.hermesBrainEnabled).toBe(true);
    expect(next.hermesBrainInstanceId).toBe("opencode");
    expect(next.hermesBrainModel).toBe("openrouter/x-ai/grok-4.5");
    expect(readBoardSettings().hermesBrainIntervalMs).toBe(30_000);
  });

  it("keeps the spaces in a roster note while it is being typed", () => {
    const next = updateBoardSettings({
      modelRoster: [
        { instanceId: "claude", model: "claude-opus-5", note: "Used for quick ", options: [] },
      ],
    });

    expect(next.modelRoster[0]?.note).toBe("Used for quick ");
    expect(readBoardSettings().modelRoster[0]?.note).toBe("Used for quick ");
  });

  it("ignores a server echo that is older than the local write it answers", () => {
    updateBoardSettings({
      modelRoster: [
        { instanceId: "claude", model: "claude-opus-5", note: "Used for q", options: [] },
      ],
    });

    applyServerBoardSettings({
      ...DEFAULT_BOARD_SETTINGS,
      modelRoster: [
        { instanceId: "claude", model: "claude-opus-5", note: "Used for", options: [] },
      ],
    });

    expect(readBoardSettings().modelRoster[0]?.note).toBe("Used for q");
  });

  it("keeps the brain switch on when a later pipeline toggle rewrites the object", () => {
    writeBoardSettings(
      { ...DEFAULT_BOARD_SETTINGS, hermesBrainEnabled: false },
      { persistRemote: false },
    );
    applyServerHermesBrainConfig({
      enabled: true,
      model: DEFAULT_BOARD_SETTINGS.hermesBrainModel,
      intervalMs: DEFAULT_BOARD_SETTINGS.hermesBrainIntervalMs,
      maxNudges: DEFAULT_BOARD_SETTINGS.hermesBrainMaxNudges,
      instanceId: "cursor",
    });

    const persisted: Array<{ hermesBrainEnabled: boolean }> = [];
    bindBoardSettingsServerPersist((sent) => {
      persisted.push(sent);
    });
    updateBoardSettings({ hermesAutoMovePromptsToActive: false });
    flushRemotePersist();

    expect(persisted.at(-1)?.hermesBrainEnabled).toBe(true);
  });
});

describe("boardSettings canvasUi", () => {
  beforeEach(() => {
    __resetBoardSettingsRemoteQueueForTests();
    const storage = createStorage();
    vi.stubGlobal("window", {
      localStorage: storage,
      dispatchEvent: () => true,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal(
      "CustomEvent",
      class CustomEvent<T> {
        readonly detail: T | undefined;
        constructor(
          readonly type: string,
          init?: { detail?: T },
        ) {
          this.detail = init?.detail;
        }
      },
    );
  });

  afterEach(() => {
    bindBoardSettingsServerPersist(null);
    vi.unstubAllGlobals();
  });

  it("defaults to the minimal canvas UI", () => {
    const settings = readBoardSettings();
    expect(settings.canvasUi.tools).toEqual([
      "select",
      "hand",
      "draw",
      "eraser",
      "rectangle",
      "ellipse",
      "text",
    ]);
    expect(settings.canvasUi.colors).toEqual(["black", "blue"]);
    expect(settings.canvasUi.stylePanel).toBe("minimal");
    expect(settings.canvasUi.showMinimap).toBe(false);
    expect(settings.canvasUi.showMenus).toBe(false);
  });

  it("drops unknown ids, canonicalizes order and keeps select", () => {
    const next = updateBoardSettings({
      canvasUi: {
        tools: ["frame", "draw", "not-a-tool", "draw"],
        colors: ["red", "nope", "black"],
        stylePanel: "everything",
        showMinimap: 1,
        showMenus: true,
      } as never,
    });
    expect(next.canvasUi.tools).toEqual(["select", "draw", "frame"]);
    expect(next.canvasUi.colors).toEqual(["black", "red"]);
    expect(next.canvasUi.stylePanel).toBe("minimal");
    expect(next.canvasUi.showMinimap).toBe(true);
    expect(next.canvasUi.showMenus).toBe(true);
  });

  it("falls back to default colors when every swatch is deselected", () => {
    const next = updateBoardSettings({ canvasUi: { colors: [] } as never });
    expect(next.canvasUi.colors).toEqual(["black", "blue"]);
  });
});

describe("the rules key survived its rename", () => {
  beforeEach(() => {
    __resetBoardSettingsRemoteQueueForTests();
    const storage = createStorage();
    vi.stubGlobal("window", {
      localStorage: storage,
      dispatchEvent: () => true,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // `rules` was `columnRules` until a card stopped sitting "in a column". A
  // board saved before that has the old key and nothing else, and dropping its
  // rows would switch every policy it had turned off back on.
  it("reads rows a board saved under the old key", () => {
    writeBoardSettings({
      ...DEFAULT_BOARD_SETTINGS,
      columnRules: { pr: [{ when: "checksGreen", then: "moveHere", arg: "" }] },
    } as never);

    expect(readBoardSettings().rules.pr).toEqual([
      { when: "checksGreen", then: "moveHere", arg: "" },
    ]);
  });

  it("prefers the new key when a board carries both", () => {
    writeBoardSettings({
      ...DEFAULT_BOARD_SETTINGS,
      rules: { pr: [{ when: "checksGreen", then: "mergePr", arg: "" }] },
      columnRules: { pr: [{ when: "checksGreen", then: "moveHere", arg: "" }] },
    } as never);

    expect(readBoardSettings().rules.pr?.[0]?.then).toBe("mergePr");
  });
});
