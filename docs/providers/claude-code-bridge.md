# Claude Code bridge

The `claude-code` bridge runs the official Claude Code executable as a
separate, headless child process. It sends a prompt through Claude Code's
documented `-p --output-format stream-json` interface and forwards streaming
events to T3 Code.

## OpenCode V2 use

This repository ships a project-local OpenCode V2 tool registration at
`.opencode/plugins/claude-code.ts` and the `/claude-code` command at
`.opencode/commands/claude-code.md`. In OpenCode, select the `claude_code`
tool directly or run `/claude-code <request>`. The tool returns streamed text
and progress metadata; `cwd`, documented model names, cancellation, and local
session resume are supported. It is deliberately a tool/command rather than
an OpenCode provider/model because OpenCode V2 cannot safely make Claude's
subscription-backed client authentication into native provider credentials.

## Install and authenticate

Install Claude Code from Anthropic, then authenticate it in a normal terminal:

```text
claude auth login
```

The bridge does not read, copy, store, or expose OAuth/session credentials.
Claude Code reads its own local account state. The bridge reports a clear
missing-CLI or authentication error when the official client is unavailable.

## Safety

- The child process uses an argument array, `shell: false`, an isolated cwd,
  bounded output, cancellation, timeout, and owned-process cleanup.
- Only the normal Claude Code environment allowlist is passed through.
  API-key and token variables are not forwarded by this bridge.
- Permission mode defaults to Claude Code's `default` mode. `bypassPermissions`
  is rejected unless an integrator explicitly enables it.
- Session IDs are generated locally and mapped to an application thread in
  `.opencode/claude-code-sessions.json`; this is not `TEAMWORK.md`.

The mapping is application state only. It contains generated Claude session
IDs, never OAuth tokens or account credentials.

This is a wrapper around the user-installed official client. It is not a
native OpenCode API provider, does not emulate Anthropic's private API, and
does not guarantee compliance with Claude, Anthropic, OpenCode, or any other
service terms. Users must review the applicable terms themselves.
