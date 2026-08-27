import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { cardRendererFor } from "@t3tools/shared/boardRules";
import { CardView } from "./CardTileView";

const PROPS = {
  headline: "fix(kanban): stop the composer eating the first keystroke",
  projectLabel: "payments-svc",
  modelLabel: "Codex · GPT-5.6-Luna",
  timeInColumn: "12m",
  ruleMove: "pr-conflicts",
  prNumber: 1450,
  prUrl: "https://github.com/Noisemaker111/vps-code/pull/1450",
  queueState: { label: "Merging PR", tone: "running" as const, title: "Merging PR" },
};

const markup = (renderer: Parameters<typeof CardView>[0]["renderer"]) =>
  renderToStaticMarkup(<CardView renderer={renderer} {...PROPS} />);

describe("CardView picks a face", () => {
  it("draws the board tile when no renderer is asked for", () => {
    expect(markup(undefined)).toBe(markup("default"));
  });

  // The registry is what decides which faces exist, so a name nothing is
  // registered under is answered here rather than filtered on the way in — and
  // the row that asked for it stays in settings for whatever wrote it.
  it("draws the board tile for a face this build does not have", () => {
    expect(markup("hologram")).toBe(markup("default"));
  });

  it("compact is one line: no project line, no model line, still the headline", () => {
    const compact = markup("compact");
    expect(compact).toContain(PROPS.headline);
    expect(compact).not.toContain("payments-svc");
    expect(compact).not.toContain("Codex · GPT-5.6-Luna");
    expect(compact).toContain("#1450");
  });

  it("detailed labels what the tile only implies", () => {
    const detailed = markup("detailed");
    expect(detailed).toContain("project");
    expect(detailed).toContain("model");
    expect(detailed).toContain("payments-svc");
    expect(detailed).toContain("by pr-conflicts");
    expect(detailed).toContain("Merging PR");
  });

  it("every face keeps the stop button when there is a turn to interrupt", () => {
    for (const renderer of ["default", "compact", "detailed"] as const) {
      const withStop = renderToStaticMarkup(
        <CardView renderer={renderer} {...PROPS} onStop={() => undefined} />,
      );
      expect(withStop).toContain('aria-label="Stop generation"');
    }
  });
});

describe("the column's display row chooses the face", () => {
  it("renders what the row names, and the tile when there is no row", () => {
    const settings = {
      rules: {
        pr: [
          { when: "cardArrives", then: "openPr", arg: "" },
          { when: "cardArrives", then: "display", arg: "compact" },
        ],
      },
    };
    expect(markup(cardRendererFor(settings, "pr"))).toBe(markup("compact"));
    expect(markup(cardRendererFor(settings, "active"))).toBe(markup("default"));
  });
});
