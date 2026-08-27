import { DndContext } from "@dnd-kit/core";
import type { KanbanCiChecks } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PrReviewListView } from "./PrReviewPanel";
import { DEFAULT_PR_FILTER, type PrListFilter, type PrReviewRow } from "./PrReviewPanel.logic";

const checkedAt = DateTime.makeUnsafe("2026-08-03T00:00:00Z");

function checks(input: Partial<KanbanCiChecks> & Pick<KanbanCiChecks, "state">): KanbanCiChecks {
  return {
    state: input.state,
    total: input.total ?? 1,
    passing: input.passing ?? 0,
    failing: input.failing ?? 0,
    pending: input.pending ?? 0,
    failingNames: input.failingNames ?? [],
    failingUrl: input.failingUrl ?? null,
    unknownReason: input.unknownReason ?? null,
    unknownDetail: input.unknownDetail ?? null,
    checkedAt,
  };
}

function row(number: number, ci: KanbanCiChecks): PrReviewRow {
  return {
    projectId: "vps-code-project",
    repo: "Noisemaker111/vps-code",
    number,
    title: `vps-code change ${number}`,
    url: `https://github.com/Noisemaker111/vps-code/pull/${number}`,
    headRefName: `feature/${number}`,
    baseRefName: "main",
    checks: ci,
    updatedAt: checkedAt,
    cardId: null,
  };
}

function render(prs: ReadonlyArray<PrReviewRow>, filter: PrListFilter = DEFAULT_PR_FILTER): string {
  return renderToStaticMarkup(
    <DndContext>
      <PrReviewListView
        repos={["vps-code"]}
        prs={prs}
        error={null}
        loading={false}
        showRepo
        filter={filter}
      />
    </DndContext>,
  );
}

describe("canvas PR review CI", () => {
  it("renders pending, passing, and failing forge states on vps-code rows", () => {
    const markup = render([
      row(1, checks({ state: "pending", total: 4, passing: 2, pending: 2 })),
      row(2, checks({ state: "passing", total: 4, passing: 4 })),
      row(
        3,
        checks({
          state: "failing",
          total: 4,
          passing: 3,
          failing: 1,
          failingNames: ["server/web typecheck gate"],
          failingUrl: "https://github.com/run/3",
        }),
      ),
    ]);

    expect(markup).toContain("CI running · 2/4");
    expect(markup).toContain("CI passed · 4");
    expect(markup).toContain("CI failed · 1");
    expect(markup).toContain("server/web typecheck gate");
  });

  it("fails closed with the real unknown reason instead of showing green", () => {
    const markup = render([
      row(
        249,
        checks({
          state: "unknown",
          total: 0,
          unknownReason: "unavailable",
          unknownDetail: "gh auth status exited 1",
        }),
      ),
    ]);

    expect(markup).toContain("CI unknown · unavailable");
    expect(markup).toContain("gh auth status exited 1");
    expect(markup).not.toContain("CI passed");
  });
});

describe("canvas PR review filtering", () => {
  const rows = [
    row(1, checks({ state: "passing", total: 1, passing: 1 })),
    row(2, checks({ state: "failing", total: 1, failing: 1 })),
  ];

  it("draws only the rows the filter keeps, and counts what it hid", () => {
    const markup = render(rows, { ...DEFAULT_PR_FILTER, ci: "failing" });

    expect(markup).toContain("vps-code change 2");
    expect(markup).not.toContain("vps-code change 1");
    expect(markup).toContain("1/2");
  });

  it("says the filter is what emptied the list, not the forge", () => {
    const markup = render(rows, { ...DEFAULT_PR_FILTER, text: "nothing matches this" });

    expect(markup).toContain("No pull request matches the filter.");
    expect(markup).not.toContain("No open pull requests.");
  });

  it("opens every row on the forge", () => {
    const markup = render(rows);

    expect(markup).toContain("https://github.com/Noisemaker111/vps-code/pull/1");
    expect(markup).toContain('aria-label="Open on the forge"');
  });
});
