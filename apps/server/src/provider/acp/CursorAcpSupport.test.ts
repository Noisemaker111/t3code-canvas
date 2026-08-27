import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";

import { applyCursorAcpModelSelection, buildCursorAcpSpawnInput } from "./CursorAcpSupport.ts";

const parameterizedGpt54ConfigOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gpt-5.4-medium-fast",
    options: [{ value: "gpt-5.4-medium-fast", name: "GPT-5.4" }],
  },
  {
    id: "reasoning",
    name: "Reasoning",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "extra-high", name: "Extra High" },
    ],
  },
  {
    id: "context",
    name: "Context",
    category: "model_config",
    type: "select",
    currentValue: "272k",
    options: [
      { value: "272k", name: "272K" },
      { value: "1m", name: "1M" },
    ],
  },
  {
    id: "fast",
    name: "Fast",
    category: "model_config",
    type: "select",
    currentValue: "false",
    options: [
      { value: "false", name: "Off" },
      { value: "true", name: "Fast" },
    ],
  },
];

describe("buildCursorAcpSpawnInput", () => {
  const cleanWindowsEnv = {
    LOCALAPPDATA: "C:\\t3-tests\\no-cursor-agent-install",
    CURSOR_AGENT_EXECUTABLE: "",
  } as const;

  it("builds the default Cursor ACP command", () => {
    expect(buildCursorAcpSpawnInput(undefined, "/tmp/project", { ...cleanWindowsEnv })).toEqual({
      command: "cursor-agent",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { ...cleanWindowsEnv },
    });
  });

  it("includes the configured api endpoint when present", () => {
    expect(
      buildCursorAcpSpawnInput(
        {
          binaryPath: "/usr/local/bin/agent",
          apiEndpoint: "http://localhost:3000",
        },
        "/tmp/project",
        { ...cleanWindowsEnv },
      ),
    ).toEqual({
      command: "/usr/local/bin/agent",
      args: ["-e", "http://localhost:3000", "acp"],
      cwd: "/tmp/project",
      env: { ...cleanWindowsEnv },
    });
  });

  it("prefers CURSOR_AGENT_EXECUTABLE over the default command name", () => {
    expect(
      buildCursorAcpSpawnInput({ binaryPath: "cursor-agent", apiEndpoint: "" }, "/tmp/project", {
        CURSOR_AGENT_EXECUTABLE: "C:\\shim\\cursor-agent-shim.exe",
      }),
    ).toEqual({
      command: "C:\\shim\\cursor-agent-shim.exe",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { CURSOR_AGENT_EXECUTABLE: "C:\\shim\\cursor-agent-shim.exe" },
    });
  });
});

describe("resolveCursorAgentBinaryPath", () => {
  it("keeps an explicit non-default binary path", async () => {
    const { resolveCursorAgentBinaryPath } = await import("./CursorAcpSupport.ts");
    expect(resolveCursorAgentBinaryPath("/opt/cursor-agent", {}, "linux")).toBe(
      "/opt/cursor-agent",
    );
  });

  it("falls back to cursor-agent when nothing else is available", async () => {
    const { resolveCursorAgentBinaryPath } = await import("./CursorAcpSupport.ts");
    expect(resolveCursorAgentBinaryPath("cursor-agent", {}, "linux")).toBe("cursor-agent");
  });
});

describe("applyCursorAcpModelSelection", () => {
  it("sets the base model before applying separate config options", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed(parameterizedGpt54ConfigOptions),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "gpt-5.4-medium-fast[reasoning=medium,context=272k]",
        selections: [
          { id: "reasoning", value: "xhigh" },
          { id: "contextWindow", value: "1m" },
          { id: "fastMode", value: true },
        ],
        mapError: ({ step, configId, cause }) =>
          step === "set-config-option"
            ? `failed to set config option ${configId}: ${cause.message}`
            : `failed to set model: ${cause.message}`,
      }),
    );

    expect(calls).toEqual([
      { type: "model", value: "gpt-5.4-medium-fast" },
      { type: "config", configId: "reasoning", value: "extra-high" },
      { type: "config", configId: "context", value: "1m" },
      { type: "config", configId: "fast", value: "true" },
    ]);
  });
});
