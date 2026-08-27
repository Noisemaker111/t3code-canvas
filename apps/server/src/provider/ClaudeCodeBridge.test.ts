// @effect-diagnostics nodeBuiltinImport:off
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    expect(resolveClaudeExecutable("C:\\Tools\\claude.exe")).toBe("C:\\Tools\\claude.exe");
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
});
