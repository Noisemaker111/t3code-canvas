/**
 * The `board.*` API as a `.d.ts`-style block — the whole point of code mode.
 *
 * It is a *coarser* surface than the kanban toolkit on purpose. One method per
 * tool meant every tick re-typed the same list-guard-update-launch and
 * merge-sync-retry code around a one-line decision. Here a verb owns the
 * mechanics — including its own guards — and the program carries the decision.
 *
 * Nothing here is reachable that `BoardApi` did not already reach; the surface
 * only got smaller. What the rules now do on their own is off it entirely.
 *
 * @module kanban/hermes/apiSurface
 */

/** The verbs. Each guards itself, so a program needs no re-checks around it. */
const VERBS: ReadonlyArray<{ readonly signature: string; readonly doc: ReadonlyArray<string> }> = [
  {
    signature:
      "applyLaunchPlan(input: { plan: LaunchPlan }): Promise<{ ok: boolean; reason: string | null; threadIds: string[] }>",
    doc: [
      "The only routing write: validates the plan against the card's brief, then structures and launches.",
    ],
  },
  {
    signature:
      "structureCard(input: { id: string; title?: string; body?: string; projectId?: string | null; modelSelection?: ModelSelection | null; keepAttachmentIds?: string[] }): Promise<{ ok: boolean; reason: string | null; card: Card | null }>",
    doc: [
      "A Prompt with no routing brief: structured body (Mission / Work to do / Constraints / Done",
      "when), project, model, ready. projectId is a PROJECTS slug. keepAttachmentIds: media that",
      "informs the task; omit to leave flags, [] drops all.",
    ],
  },
  {
    signature:
      "advanceCard(input: { id: string; projectId?: string }): Promise<{ ok: boolean; reason: string | null; threadId: string | null }>",
    doc: ["Launch a card that has no routing brief."],
  },
  {
    signature:
      "finishCard(input: { id: string }): Promise<{ ok: boolean; reason: string | null; prUrl: string | null; merged: boolean }>",
    doc: [
      "Commit, push and open the PR. Never merges — a rule does that on a later tick once checks",
      "are green, so merged is always false. A reason is a refusal; say so in note().",
    ],
  },
  {
    signature:
      "closePr(input: { id: string; reference?: string }): Promise<{ closed: boolean; reason: string | null }>",
    doc: [
      "Abandon a pull request, and archive its card. Defaults to the card's own prUrl; pass",
      "reference for one it does not own. closed: false is a refusal — say so in note().",
    ],
  },
  {
    signature:
      "searchProjects(input: { query: string; limit?: number }): Promise<{ ambiguous: boolean; projects: { projectId: string; slug: string; hits: number; paths: string[] }[] }>",
    doc: [
      "Which projects hold files matching a path, most hits first. One entry is the answer;",
      "ambiguous means two checkouts claim it. limit 5, max 20.",
    ],
  },
  {
    signature:
      "askUser(input: { cardId: string; question: string; options?: string[] }): Promise<{ ok: boolean; reason: string | null }>",
    doc: [
      "One blocking clarification for intent no repository evidence can decide. Give short concrete",
      "options. Do not ask again while this sits in ALREADY TRIED unanswered.",
    ],
  },
  {
    signature: "nudgeThread(input: { threadId: string; text: string }): Promise<void>",
    doc: [
      "A follow-up turn naming the exact remaining items. Never ask a thread to branch, commit,",
      "push or open a PR — it has no git; finishCard does git.",
    ],
  },
  {
    signature:
      "askHelper(input: { question: string; cardId?: string | null; projectId?: string | null; modelSelection?: ModelSelection; aboutThreadId?: string | null }): Promise<{ ok: boolean; reason: string | null; helperId: string | null }>",
    doc: [
      "Hand a question you cannot settle to a throwaway read-and-report thread. Returns at once;",
      "the answer lands in a later HELPERS block and its card leaves the queue until it does.",
      "aboutThreadId attaches that thread's transcript, so you never read it. One per card.",
    ],
  },
  {
    signature:
      "threadTranscript(input: { threadId: string; limit?: number }): Promise<{ exists: boolean; archived: boolean; turnState: string; idleForMs: number | null; messageCount: number; entries: { at: string; role: string; text: string }[] } | null>",
    doc: ["The tail of what a thread actually said and did. limit defaults to 12, max 40."],
  },
  {
    signature:
      "answerPermission(input: { threadId: string; requestId: string; answer: string }): Promise<void>",
    doc: ["Answer one blocked permission question with one of its own options."],
  },
  {
    signature:
      "createCard(input: { title: string; body: string; projectId?: string | null; modelSelection?: ModelSelection | null }): Promise<Card>",
    doc: ["Generic card creation. A routing split belongs inside applyLaunchPlan."],
  },
  {
    signature: "archiveCard(input: { id: string; archived?: boolean }): Promise<Card>",
    doc: ["Take an obsolete or delivered card off the board; archived: false restores it."],
  },
  {
    signature:
      "updateCard(input: { id: string; title?: string; body?: string; column?: Column; projectId?: string | null; modelSelection?: ModelSelection | null }): Promise<Card>",
    doc: ["The escape hatch for a move no verb covers. Prefer the verbs."],
  },
  {
    signature: "readCanvas(): Promise<CanvasDigest>",
    doc: ["What is already drawn on the canvas. Read before you draw."],
  },
  {
    signature:
      "drawOnCanvas(input: { title: string; nodes: CanvasNode[]; edges: CanvasEdge[]; note?: string | null; focus?: boolean }): Promise<{ ok: boolean; reason: string | null; id: string | null }>",
    doc: [
      "Draw when a picture answers better than prose. Lands in its own titled frame; omit x/y and",
      "it is laid out for you. Edges name keys from this call. focus: true pans the viewport, so",
      "leave it off unless asked. Max 40 nodes.",
    ],
  },
  {
    signature: "reply(input: { text: string }): Promise<void>",
    doc: [
      "Answer whoever typed at you, in full — this lands in the panel verbatim. It changes nothing:",
      "a request to do something is still done by acting. One reply per question.",
    ],
  },
  {
    signature:
      "learn(input: { lesson: string; projectId?: string | null; topic?: string; evidence?: string }): Promise<{ ok: boolean; reason: string | null; lessonId: string | null }>",
    doc: [
      "Write down one thing the next agent would otherwise get wrong; every later launch into that",
      "project carries it. One imperative sentence, no card ids. Omit projectId only for a fact",
      "about the box itself.",
    ],
  },
  {
    signature:
      "forget(input: { id: string; reason: string }): Promise<{ ok: boolean; reason: string | null }>",
    doc: ["Retire a KNOWLEDGE lesson that work proved wrong. The id is the one on its line."],
  },
  {
    signature: "note(input: { text: string }): Promise<void>",
    doc: [
      "One short line for what counters cannot say. The tick writes its own summary — do not restate",
      "counts, and skip it when there is nothing to add.",
    ],
  },
];

/**
 * Types the program has to *write*, not every type it can see.
 *
 * A LaunchPlan is authored by the model, so its whole shape has to be here. A
 * Card is only ever read back off a verb's return, and a field list nothing
 * branches on is a table the tick pays for on every cached miss — so Card
 * carries the fields a decision actually uses.
 */
const TYPES = [
  "type Column = 'prompts' | 'active' | 'pr' | 'done';",
  "type ModelSelection = { instanceId: string; model: string; options?: { id: string; value: string | boolean }[] };",
  "type UsageEstimate = { lowPercent: number | null; likelyPercent: number | null; highPercent: number | null;",
  "  confidence: 'measured' | 'learned' | 'estimated' | 'unknown'; basis: string };",
  "type Level = 'none' | 'low' | 'medium' | 'high';",
  "type ExpectedWork = { investigation: Level; implementation: Level; verification: Level;",
  "  risk: 'low' | 'medium' | 'high' | 'critical'; contextPressure: 'low' | 'medium' | 'high';",
  "  expectedTurns: [number, number] };",
  "type LaunchTask = { sourceCardId: string; title: string; brief: string; projectId: string;",
  "  placement: { kind: 'new'; threadId: null } | { kind: 'reuse'; threadId: string };",
  "  execution: { routeId: string; selection: ModelSelection; usage: UsageEstimate };",
  "  expectedWork: ExpectedWork; reason: string; alternativesConsidered: string[];",
  "  provenance: { source: 'hermes'; skill: 'select-execution'; at: string } };",
  "type LaunchPlan = { version: 1; status: 'ready' | 'blocked'; sourceCardId: string;",
  "  tasks: LaunchTask[]; blockedReason: string | null };",
  "type Card = { id: string; title: string; body: string; at: Column; threadId: string | null;",
  "  prUrl: string | null; projectId: string | null; modelSelection: ModelSelection | null;",
  "  prepStatus: 'untouched' | 'processing' | 'ready'; baseBranch: string | null };",
  "type CanvasNode = { key: string; text: string; shape?: 'rectangle' | 'ellipse' | 'diamond' | 'note';",
  "  color?: 'black' | 'blue' | 'green' | 'grey' | 'orange' | 'red' | 'violet' | 'yellow';",
  "  x?: number; y?: number; width?: number; height?: number; cardId?: string | null };",
  "type CanvasEdge = { from: string; to: string; label?: string };",
  "type CanvasDigest = { shapeCount: number; untitledCount: number;",
  "  shapes: { id: string; kind: string; text: string; x: number; y: number }[] };",
].join("\n");

/** The block the system prompt carries. No JSON schemas anywhere. */
export function buildBoardApiSurface(): string {
  const lines: string[] = [TYPES, "", "declare const board: {"];
  for (const verb of VERBS) {
    for (const line of verb.doc) lines.push(`  // ${line}`);
    lines.push(`  ${verb.signature};`);
  }
  lines.push("};");
  return lines.join("\n");
}

/** Method names a program may call. The executor builds exactly these. */
export const BOARD_VERB_NAMES: ReadonlyArray<string> = VERBS.map((verb) =>
  verb.signature.slice(0, verb.signature.indexOf("(")),
);

const MCP_SCHEMA_MAX_DEPTH = 4;
const MCP_DOC_MAX_CHARS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Render one advertised JSON Schema as a TypeScript type. Deliberately partial:
 * past `MCP_SCHEMA_MAX_DEPTH`, or on a construct with no cheap TS equivalent,
 * it says `unknown` rather than inventing a shape the server never promised.
 */
function renderJsonSchemaType(schema: unknown, depth = 0): string {
  if (!isRecord(schema)) return "unknown";
  if (depth >= MCP_SCHEMA_MAX_DEPTH) return "unknown";
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues.map((value) => JSON.stringify(value)).join(" | ");
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union) && union.length > 0) {
    return union.map((member) => renderJsonSchemaType(member, depth + 1)).join(" | ");
  }
  const type = schema.type;
  if (Array.isArray(type)) {
    return type
      .map((member) => renderJsonSchemaType({ ...schema, type: member }, depth))
      .join(" | ");
  }
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `${renderJsonSchemaType(schema.items, depth + 1)}[]`;
    case "object":
      return renderObjectType(schema, depth);
    default:
      return isRecord(schema.properties) ? renderObjectType(schema, depth) : "unknown";
  }
}

function renderObjectType(schema: Record<string, unknown>, depth: number): string {
  const properties = schema.properties;
  if (!isRecord(properties)) return "Record<string, unknown>";
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === "string") : [],
  );
  const fields = Object.entries(properties).map(([key, value]) => {
    const optional = required.has(key) ? "" : "?";
    const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
    return `${name}${optional}: ${renderJsonSchemaType(value, depth + 1)}`;
  });
  return fields.length === 0 ? "Record<string, unknown>" : `{ ${fields.join("; ")} }`;
}

function memberName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * The `mcp.*` block, generated from what the servers advertise.
 *
 * A separate namespace on purpose: these are raw tools, one call per tool, with
 * none of the guards a `board.*` verb owns. Promoting them into `board.*` is
 * the mirroring this module's header already rejected.
 */
export function buildMcpApiSurface(toolset: {
  readonly servers: ReadonlyArray<{
    readonly name: string;
    readonly tools: ReadonlyArray<{
      readonly name: string;
      readonly description: string;
      readonly inputSchema: unknown;
    }>;
  }>;
  readonly unavailable: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}): string {
  if (toolset.servers.length === 0 && toolset.unavailable.length === 0) return "";
  const lines: string[] = [];
  for (const entry of toolset.unavailable) {
    lines.push(`// UNAVAILABLE: mcp.${entry.name} did not connect — ${entry.reason}`);
  }
  if (toolset.servers.length === 0) return lines.join("\n");
  lines.push("declare const mcp: {");
  for (const server of toolset.servers) {
    lines.push(`  ${memberName(server.name)}: {`);
    for (const tool of server.tools) {
      const doc = tool.description.replace(/\s+/g, " ").trim().slice(0, MCP_DOC_MAX_CHARS);
      if (doc.length > 0) lines.push(`    /** ${doc} */`);
      lines.push(
        `    ${memberName(tool.name)}(input: ${renderJsonSchemaType(tool.inputSchema)}): Promise<unknown>;`,
      );
    }
    lines.push("  };");
  }
  lines.push("};");
  return lines.join("\n");
}
