import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  DEFAULT_BOARD_SETTINGS,
  DEFAULT_CANVAS_DOC_ID,
  ProviderDriverKind,
  type BoardSettings,
  type CanvasMessage,
} from "@t3tools/contracts";

import type { HermesBackend } from "./backend.ts";
import { hermesChatEntries, unbindHermesChat } from "./chatStore.ts";
import { makeFakeBoardApi, makeFakeCard } from "./fakeBoardApi.ts";
import { collectSnapshot, resetHermesBrainState, runOneTick } from "./HermesBrain.ts";
import { judgmentQueue } from "./judgment.ts";

const settings = (patch: Partial<BoardSettings> = {}): BoardSettings => ({
  ...DEFAULT_BOARD_SETTINGS,
  hermesBrainInstanceId: "cursor",
  ...patch,
});

const answering = (program: string): HermesBackend => ({
  tier: "cursor",
  driver: ProviderDriverKind.make("cursor"),
  available: async () => ({ tier: "cursor", available: true, detail: "ok" }),
  complete: async () => ({ text: `\`\`\`js\n${program}\n\`\`\`` }),
});

const hermesMessage = (id: string, text: string): CanvasMessage =>
  ({
    id,
    docId: DEFAULT_CANVAS_DOC_ID,
    authorKind: "human",
    authorId: null,
    text,
    image: null,
    hasImage: false,
    target: "hermes",
    targetId: null,
    createdAt: DateTime.makeUnsafe(0),
    deliveredAt: null,
  }) as unknown as CanvasMessage;

describe("a message addressed to Hermes", () => {
  it("queues on an otherwise settled board, so a quiet tick still asks a tier", async () => {
    resetHermesBrainState();
    const { api } = makeFakeBoardApi({
      canvasMessages: [hermesMessage("m1", "what are you working on?")],
    });

    const queue = judgmentQueue({
      snapshot: await collectSnapshot(api, settings()),
      settings: settings(),
    });

    expect(queue.map((item) => item.kind)).toEqual(["message"]);
    expect(queue[0]?.why).toContain("what are you working on?");
  });

  it("answers in the panel at full length and takes the message out of the inbox", async () => {
    resetHermesBrainState();
    unbindHermesChat();
    const answer =
      `Nothing is running. ${"The board is empty and no thread is open. ".repeat(20)}`.trim();
    const { api, state } = makeFakeBoardApi({
      canvasMessages: [hermesMessage("m1", "what are you working on?")],
    });

    await runOneTick({
      api,
      backends: [answering(`await board.reply({ text: ${JSON.stringify(answer)} });`)],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    });

    const reply = hermesChatEntries().find((entry) => entry.kind === "reply");
    expect(reply?.summary).toBe(answer);
    expect(state.canvasAcked).toEqual(["m1"]);
  });

  it("leaves the mail in the inbox when the run is a dry run", async () => {
    resetHermesBrainState();
    const { api, state } = makeFakeBoardApi({
      canvasMessages: [hermesMessage("m1", "what are you working on?")],
    });

    const transcript = await runOneTick(
      {
        api,
        backends: [answering("await board.reply({ text: 'nothing' });")],
        boardSettings: async () => settings(),
      },
      { recordOnly: true },
    );

    expect(transcript.recordOnly).toBe(true);
    expect(state.canvasAcked).toEqual([]);
  });

  it("attaches the card's recorded ticks when the question names it", async () => {
    resetHermesBrainState();
    unbindHermesChat();
    const { api, state } = makeFakeBoardApi({
      cards: [
        makeFakeCard({
          id: "c1",
          at: "prompts",
          title: "Stop the flashing toast",
          body: "make the toast stop flashing",
        }),
      ],
    });

    await runOneTick({
      api,
      backends: [answering("await board.archiveCard({ id: 'c1', archived: false });")],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    });

    state.canvasMessages.push(hermesMessage("m1", "why did you route the flashing toast there?"));
    let asked = "";
    await runOneTick({
      api,
      backends: [
        {
          tier: "cursor",
          driver: ProviderDriverKind.make("cursor"),
          available: async () => ({ tier: "cursor", available: true, detail: "ok" }),
          complete: async (input) => {
            asked = input.user;
            return { text: "```js\nawait board.reply({ text: 'because it matched' });\n```" };
          },
        },
      ],
      boardSettings: async () => settings({ hermesBrainEnabled: true }),
    });

    expect(asked).toContain("## CARD HISTORY");
    expect(asked).toContain("archiveCard → ok");
  });
});
