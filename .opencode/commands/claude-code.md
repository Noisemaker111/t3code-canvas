---
description: Run the official Claude Code client for this workspace
agent: build
---

Use the `claude_code` tool for this request. Pass the user's request as `prompt`, use the current workspace as `cwd`, and use the current OpenCode session ID as `sessionKey` when resuming. Do not claim this is a native provider or handle authentication: Claude Code owns login, subscription access, sessions, rate limits, and network traffic.

User request:
$ARGUMENTS
