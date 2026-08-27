// @effect-diagnostics nodeBuiltinImport:off
// oxlint-disable t3code/namespace-node-imports -- test harness uses direct Node filesystem/process APIs
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";

import {
  buildClaudeCodeEnvironment,
  parseClaudeEvent,
  redactClaudeOutput,
  resolveClaudeExecutable,
  runClaudeCode,
} from "./ClaudeCodeBridge.ts";

describe("ClaudeCodeBridge", () => {
  it("parses documented streaming deltas and final results", () => {
    const delta = parseClaudeEvent(
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}}',
    );
    expect(delta.event).toEqual({ type: "text", text: "hello" });
    expect(delta.isDelta).toBe(true);
    expect(parseClaudeEvent('{"type":"result","result":"done"}').event).toEqual({
      type: "result",
      result: "done",
    });
  });

  it("redacts credential-shaped diagnostics", () => {
    expect(redactClaudeOutput("Authorization: Bearer abc api_key=secret")).toBe(
      "Authorization: Bearer [REDACTED] api_key=[REDACTED]",
    );
  });

  it("resolves an explicit executable without PATH lookup", () => {
    expect(resolveClaudeExecutable(process.execPath)).toBe(process.execPath);
  });

  it("rejects missing absolute and discovered executables before spawning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-missing-"));
    try {
      await expect(
        runClaudeCode({
          cwd: directory,
          prompt: "hello",
          executable: join(directory, "missing-claude"),
        }),
      ).rejects.toMatchObject({ code: "not-found" });
      await expect(
        runClaudeCode({ cwd: directory, prompt: "hello", env: { PATH: directory } }),
      ).rejects.toMatchObject({ code: "not-found" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not forward API credentials in the child environment", () => {
    const environment = buildClaudeCodeEnvironment({
      PATH: "path",
      ANTHROPIC_API_KEY: "secret",
      CLAUDE_CONFIG_DIR: "config",
    });
    expect(environment).toEqual({ PATH: "path", CLAUDE_CONFIG_DIR: "config" });
  });

  it("fails closed for bypass permissions", async () => {
    await expect(
      runClaudeCode({ cwd: process.cwd(), prompt: "hello", permissionMode: "bypassPermissions" }),
    ).rejects.toMatchObject({ code: "invalid-config" });
  });

  it("streams a fake official-cli-compatible process and persists resume ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-"));
    const fake = join(directory, "fake-claude.mjs");
    await writeFile(
      fake,
      [
        "process.stdin.resume();",
        'process.stdin.on("end", () => {',
        ' console.log(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"hello"}}}));',
        ' console.log(JSON.stringify({type:"result",result:"hello"}));',
        "});",
      ].join("\n"),
    );
    try {
      const first = await runClaudeCode({
        cwd: directory,
        prompt: "hello",
        executable: process.execPath,
        executableArgs: [fake],
        sessionKey: "thread-1",
        env: { FAKE: "1" },
      });
      const second = await runClaudeCode({
        cwd: directory,
        prompt: "again",
        executable: process.execPath,
        executableArgs: [fake],
        sessionKey: "thread-1",
        resume: true,
      });
      expect(first.text).toBe("hello");
      expect(first.sessionId).toBeTruthy();
      expect(second.sessionId).toBe(first.sessionId);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports a process error without leaking stderr credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-"));
    const fake = join(directory, "fake-error.mjs");
    await writeFile(fake, 'console.error("api_key=secret"); process.exit(7);');
    try {
      await expect(
        runClaudeCode({
          cwd: directory,
          prompt: "hello",
          executable: process.execPath,
          executableArgs: [fake],
          env: { FAKE: "1" },
        }),
      ).rejects.toMatchObject({ code: "process", message: "api_key=[REDACTED]" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("enforces timeout and cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-"));
    const fake = join(directory, "fake-hang.mjs");
    await writeFile(fake, "setTimeout(() => process.exit(0), 500);");
    try {
      await expect(
        runClaudeCode({
          cwd: directory,
          prompt: "hello",
          executable: process.execPath,
          executableArgs: [fake],
          timeoutMs: 30,
        }),
      ).rejects.toMatchObject({ code: "timeout" });
      const controller = new AbortController();
      const pending = runClaudeCode({
        cwd: directory,
        prompt: "hello",
        executable: process.execPath,
        executableArgs: [fake],
        signal: controller.signal,
      });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cleans up a child descendant on timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-tree-"));
    const fake = join(directory, "fake-tree.mjs");
    const pidFile = join(directory, "descendant.pid");
    await writeFile(
      fake,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        "writeFileSync(process.env.CLAUDE_CONFIG_DIR, String(descendant.pid));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    try {
      await expect(
        runClaudeCode({
          cwd: directory,
          prompt: "hello",
          executable: process.execPath,
          executableArgs: [fake],
          timeoutMs: 100,
          env: { CLAUDE_CONFIG_DIR: pidFile },
        }),
      ).rejects.toMatchObject({ code: "timeout" });
      const pid = Number(await readFile(pidFile, "utf8"));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("registers and invokes the visible OpenCode claude_code tool", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-registration-"));
    const fake = join(directory, "fake-claude.mjs");
    await writeFile(
      fake,
      'process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({type:"result",result:"registered"})));',
    );
    try {
      const module = await import("../../../../.opencode/plugins/claude-code.ts");
      const added: Array<{ readonly name?: string; readonly execute?: Function }> = [];
      await module.default.setup({
        tool: {
          transform: async (transform) =>
            transform({ add: (tool) => added.push(tool as (typeof added)[number]) }),
        },
      });
      const tool = added.find((candidate) => candidate.name === "claude_code");
      expect(tool?.name).toBe("claude_code");
      const fakeTool = module.makeClaudeCodeTool(async (options) =>
        runClaudeCode({ ...options, executable: process.execPath, executableArgs: [fake] }),
      );
      const result = await fakeTool.execute({ prompt: "hello", cwd: directory }, undefined);
      const direct = await runClaudeCode({
        cwd: directory,
        prompt: "hello",
        executable: process.execPath,
        executableArgs: [fake],
      });
      expect(typeof result.content).toBe("string");
      expect(direct.text).toBe("");
      expect(direct.events).toContainEqual({ type: "result", result: "registered" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
