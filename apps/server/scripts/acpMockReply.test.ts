import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  buildCommitMessagePrompt,
  buildPromptAssistPrompt,
} from "../src/textGeneration/TextGenerationPrompts.ts";
import { deriveMockReply, extractUserMessage, parseResponseShapeKeys } from "./acpMockReply.ts";

describe("parseResponseShapeKeys", () => {
  it("reads a single-key shape", () => {
    assert.deepEqual(parseResponseShapeKeys("Return a JSON object with key: branch."), [
      { name: "branch", isArray: false },
    ]);
  });

  it("marks array-typed keys so they decode as arrays", () => {
    assert.deepEqual(
      parseResponseShapeKeys(
        "Return ONLY a JSON object (no markdown fences) with keys: reply (string), actions (array).",
      ),
      [
        { name: "reply", isArray: false },
        { name: "actions", isArray: true },
      ],
    );
  });

  it("returns nothing for a prompt that declares no shape", () => {
    assert.deepEqual(parseResponseShapeKeys("Write me a haiku."), []);
  });
});

describe("extractUserMessage", () => {
  it("takes the text after the last marker", () => {
    assert.equal(
      extractUserMessage("Rules:\n- be brief\n\nUser message:\nship the board fix"),
      "ship the board fix",
    );
  });

  it("is empty when the envelope has no user section", () => {
    assert.equal(extractUserMessage("no envelope here"), "");
  });
});

describe("deriveMockReply", () => {
  it("echoes the card body back for the skill / prompt-assist shape", () => {
    const { prompt, outputSchema } = buildPromptAssistPrompt({
      operation: "skill",
      text: "make the login page dark",
    });

    const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(outputSchema))(
      deriveMockReply(prompt),
    );
    assert.equal(decoded.text, "make the login page dark");
  });

  it("answers the commit-message shape with every declared key", () => {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: "main",
      stagedSummary: "1 file changed",
      stagedPatch: "diff --git a/a b/a",
      includeBranch: false,
    });

    const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(outputSchema))(
      deriveMockReply(prompt),
    );
    assert.isString(decoded.subject);
    assert.isAtMost(decoded.subject.length, 72);
    assert.isString(decoded.body);
  });

  it("replies in prose when the prompt is a plain thread turn", () => {
    assert.equal(deriveMockReply("hello"), "hello from mock");
  });
});
