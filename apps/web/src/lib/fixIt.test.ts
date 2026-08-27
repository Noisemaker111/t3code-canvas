import { describe, expect, it } from "vite-plus/test";

import { fixItPrompt, fixItTitle, type FixItContext, type FixItError } from "./fixIt";

const context: FixItContext = {
  href: "https://code.noisemakerjon.com/kanban",
  version: "1.2.3",
  buildSha: "abc1234",
};

const error = (title: string, description: string, timestamp = 0): FixItError => ({
  title,
  description,
  timestamp,
});

describe("fixItPrompt", () => {
  it("carries the error, the page and the build", () => {
    const prompt = fixItPrompt(
      [error("Usage unavailable", "Claude CLI login is not available.")],
      context,
    );

    expect(prompt).toContain("Fix this error from the T3 Code app.");
    expect(prompt).toContain("Usage unavailable");
    expect(prompt).toContain("Claude CLI login is not available.");
    expect(prompt).toContain("URL: https://code.noisemakerjon.com/kanban");
    expect(prompt).toContain("Version: 1.2.3 (build abc1234)");
    expect(prompt).toContain("journalctl -u t3j");
  });

  it("numbers several errors oldest first", () => {
    const prompt = fixItPrompt(
      [error("Newest", "second", 2_000), error("Oldest", "first", 1_000)],
      context,
    );

    expect(prompt).toContain("Fix these 2 errors from the T3 Code app.");
    expect(prompt.indexOf("1. ")).toBeLessThan(prompt.indexOf("2. "));
    expect(prompt.indexOf("Oldest")).toBeLessThan(prompt.indexOf("Newest"));
  });
});

describe("fixItTitle", () => {
  it("names the first error", () => {
    expect(fixItTitle([error("Usage unavailable", "…")])).toBe("Fix: Usage unavailable");
  });

  it("counts the rest", () => {
    expect(fixItTitle([error("A", "…"), error("B", "…"), error("C", "…")])).toBe(
      "Fix: A (+2 more)",
    );
  });

  it("clips a long title", () => {
    const title = fixItTitle([error("x".repeat(400), "…")]);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith("…")).toBe(true);
  });

  it("survives an empty list", () => {
    expect(fixItTitle([])).toBe("Fix an app error");
  });
});
