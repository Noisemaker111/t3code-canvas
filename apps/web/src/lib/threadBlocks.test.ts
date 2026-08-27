import { describe, expect, it } from "vite-plus/test";

import { parseThreadBlocks, threadsForLaunch } from "./threadBlocks";

describe("parseThreadBlocks", () => {
  it("returns empty when no fence (no false spawns from prose)", () => {
    expect(
      parseThreadBlocks(
        "I was thinking about thread 1 of the conversation and thread 2 in standup",
      ),
    ).toEqual([]);
  });

  it("parses fenced multi-thread blocks with models", () => {
    const body = `
Intro text that must not spawn.

\`\`\`t3-threads
### Thread 1 — openrouter/anthropic/claude-sonnet-4
Fix the login squish.

### Thread 2 — openrouter/openai/gpt-4.1-mini
Add a layout test.
\`\`\`
`;
    const blocks = parseThreadBlocks(body);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      index: 1,
      model: "openrouter/anthropic/claude-sonnet-4",
      prompt: "Fix the login squish.",
    });
    expect(blocks[1]?.prompt).toContain("layout test");
  });

  it("threadsForLaunch falls back to whole body", () => {
    const one = threadsForLaunch("Ship the toast fix", "Toast");
    expect(one).toHaveLength(1);
    expect(one[0]?.prompt).toBe("Ship the toast fix");
  });
});
