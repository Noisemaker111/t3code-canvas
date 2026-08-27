import { describe, expect, it } from "@effect/vitest";

import { sanitizePrBody, sanitizePrTitle } from "./TextGenerationUtils.ts";

describe("sanitizePrBody", () => {
  it("unwraps a body that is the envelope the model was asked to return", () => {
    // What shipped as the description of PR #146: the whole JSON object, escaped.
    const raw = JSON.stringify({
      title: "Streamline kanban workflow",
      body: "## Summary\n\n- consolidate the columns\n\n## Testing\n\n- Not run",
    });

    expect(sanitizePrBody(raw)).toBe(
      "## Summary\n\n- consolidate the columns\n\n## Testing\n\n- Not run",
    );
  });

  it("unwraps an envelope the model fenced as json", () => {
    const raw = ["```json", JSON.stringify({ title: "x", body: "## Summary\n\n- y" }), "```"].join(
      "\n",
    );

    expect(sanitizePrBody(raw)).toBe("## Summary\n\n- y");
  });

  it("leaves real markdown alone, including a json block inside it", () => {
    const body =
      '## Summary\n\n- adds a config\n\n```json\n{ "a": 1 }\n```\n\n## Testing\n\n- Not run';

    expect(sanitizePrBody(body)).toBe(body);
  });

  it("leaves a body that only looks like json alone", () => {
    expect(sanitizePrBody("{ not really json")).toBe("{ not really json");
  });
});

describe("sanitizePrTitle", () => {
  it("drops a leading dash that gh would read as a flag", () => {
    expect(sanitizePrTitle("- fix the merge dance")).toBe("fix the merge dance");
  });

  it("keeps the title to one line and one subject length", () => {
    const long = `${"a".repeat(120)}\nsecond line`;

    expect(sanitizePrTitle(long)).toHaveLength(72);
  });

  it("strips quotes, heading markers and a trailing period", () => {
    expect(sanitizePrTitle('## "Ship the board loop."')).toBe("Ship the board loop");
  });

  it("falls back when the model returned nothing usable", () => {
    expect(sanitizePrTitle("   \n  ")).toBe("Update project changes");
  });
});
