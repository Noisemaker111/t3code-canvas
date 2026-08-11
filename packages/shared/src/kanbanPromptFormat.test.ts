import { describe, expect, it } from "vitest";

import {
  formatKanbanStructuredPrompt,
  kanbanPromptTitleFromBody,
  parseKanbanStructuredPrompt,
  stripKanbanProjectModelHeaders,
} from "./kanbanPromptFormat.ts";

describe("kanbanPromptFormat", () => {
  it("round-trips structured headers", () => {
    const body = formatKanbanStructuredPrompt({
      goal: "Fix root terminal button",
      projectLabel: "vps-code",
      projectId: "proj_1",
      modelInstanceId: "claudeAgent",
      modelSlug: "claude-sonnet-4-5",
      size: "small",
      description: "Clicking root does nothing.",
    });
    expect(body).toContain("# Goal: Fix root terminal button");
    expect(body).toContain("# Project: vps-code (id=proj_1)");
    expect(body).toContain("# Model: claudeAgent / claude-sonnet-4-5");
    expect(body).toContain("# Size: small");
    expect(body).toContain("Clicking root does nothing.");

    const parsed = parseKanbanStructuredPrompt(body);
    expect(parsed.goal).toBe("Fix root terminal button");
    expect(parsed.projectId).toBe("proj_1");
    expect(parsed.modelInstanceId).toBe("claudeAgent");
    expect(parsed.modelSlug).toBe("claude-sonnet-4-5");
    expect(parsed.size).toBe("small");
    expect(parsed.description).toContain("Clicking root does nothing.");
    expect(kanbanPromptTitleFromBody(body)).toBe("Fix root terminal button");
  });

  it("strips Project/Model headers so fields stay authoritative", () => {
    const stripped = stripKanbanProjectModelHeaders(
      [
        "# Goal: Shrink the div",
        "# Project: (unspecified — no project named)",
        "# Model: (unspecified — no model named)",
        "# Size: small",
        "",
        "Make padding and gap smaller.",
      ].join("\n"),
    );
    expect(stripped).toContain("# Goal: Shrink the div");
    expect(stripped).toContain("# Size: small");
    expect(stripped).toContain("Make padding and gap smaller.");
    expect(stripped).not.toMatch(/#\s*Project:/i);
    expect(stripped).not.toMatch(/#\s*Model:/i);
    expect(stripped).not.toContain("unspecified");
  });
});
