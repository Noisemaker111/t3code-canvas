import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldShowOpenInPicker } from "./ChatHeader";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(true);
  });

  it("hides the picker when hosted static mode has no primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
      }),
    ).toBe(false);
  });

  it("hides the picker for remote environments", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });
});

/**
 * Back leaves the page you are on for the canvas under it. Navigating to the
 * board instead dropped you inside a region you were never in. A phone keeps a
 * station, because the canvas at that width is unreadable.
 */
describe("the back button goes out, not to the board", () => {
  const source = Object.values(
    import.meta.glob("./ChatHeader.tsx", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>,
  )[0] as string;

  it("navigates with no station on a wide window", () => {
    expect(source).toContain("narrow ?");
    expect(source).toContain('entityId: "prompts"');
    expect(source).not.toContain('kind: "board"');
  });
});
