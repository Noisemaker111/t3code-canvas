# Claude Code bridge

The `claude-code` bridge runs the official Claude Code executable as a
separate, headless child process. It sends a prompt through Claude Code's
documented `-p --output-format stream-json` interface and forwards streaming
events to T3 Code.

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

This is a wrapper around the user-installed official client. It is not a
native OpenCode API provider, does not emulate Anthropic's private API, and
does not guarantee compliance with Claude, Anthropic, OpenCode, or any other
service terms. Users must review the applicable terms themselves.
