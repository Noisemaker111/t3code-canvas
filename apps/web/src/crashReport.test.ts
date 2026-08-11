import { describe, expect, it } from "vite-plus/test";

import { crashDetails, crashMessage, formatCrashReportForAgent } from "./crashReport";

describe("crashMessage", () => {
  it("uses the error message when present", () => {
    expect(crashMessage(new Error("boom"))).toBe("boom");
  });

  it("uses a thrown string as-is", () => {
    expect(crashMessage("plain failure")).toBe("plain failure");
  });

  it("falls back for blank and non-error values", () => {
    expect(crashMessage(new Error("  "))).toBe("An unexpected router error occurred.");
    expect(crashMessage(undefined)).toBe("An unexpected router error occurred.");
  });
});

describe("crashDetails", () => {
  it("prefers the stack over the message", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at somewhere";
    expect(crashDetails(error)).toBe("Error: boom\n    at somewhere");
  });

  it("serializes non-error values", () => {
    expect(crashDetails({ status: 500 })).toBe('{\n  "status": 500\n}');
  });

  it("says so when nothing serializes", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(crashDetails(circular)).toBe("No additional error details are available.");
  });
});

describe("formatCrashReportForAgent", () => {
  it("produces a paste-ready report with message, context, and details", () => {
    const text = formatCrashReportForAgent({
      message: "boom",
      details: "Error: boom\n    at somewhere",
      href: "https://code.example.com/kanban",
      at: "2026-08-02T10:36:00.000Z",
      version: "1.2.3",
      buildSha: "abc1234",
    });
    expect(text).toContain("The T3 Code web app crashed");
    expect(text).toContain("Message: boom");
    expect(text).toContain("URL: https://code.example.com/kanban");
    expect(text).toContain("Time: 2026-08-02T10:36:00.000Z");
    expect(text).toContain("Version: 1.2.3 (build abc1234)");
    expect(text).toContain("Error: boom\n    at somewhere");
  });
});
