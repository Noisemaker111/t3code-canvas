/**
 * Derive a plausible agent reply from a T3 Code text-generation prompt so the
 * ACP mock agent can stand in for a real, billed CLI end to end.
 *
 * `TextGenerationPrompts` builds every prompt from the same envelope: a
 * response-shape line naming the JSON keys the caller will decode, then a
 * `User message:` section. Reading both back out is enough to answer with
 * something that decodes, which is what lets the board, Hermes skills, commit
 * messages and PR titles run without spending a token.
 *
 * @module acpMockReply
 */

const RESPONSE_SHAPE_PATTERN = /Return (?:ONLY )?a JSON object[^:]*?with keys?:\s*([^\n]+)/i;
const USER_MESSAGE_MARKER = "User message:";

export interface MockReplyKey {
  readonly name: string;
  readonly isArray: boolean;
}

/** Parse `…with keys: reply (string), actions (array).` into its key list. */
export function parseResponseShapeKeys(prompt: string): ReadonlyArray<MockReplyKey> {
  const declared = RESPONSE_SHAPE_PATTERN.exec(prompt)?.[1];
  if (!declared) return [];
  const keys: Array<MockReplyKey> = [];
  for (const raw of declared.replace(/[.]\s*$/, "").split(",")) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    const name = entry.replace(/\(.*$/, "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    keys.push({ name, isArray: /\(\s*array\s*\)/i.test(entry) });
  }
  return keys;
}

/** Pull the caller's own text back out of the prompt envelope. */
export function extractUserMessage(prompt: string): string {
  const markerAt = prompt.lastIndexOf(USER_MESSAGE_MARKER);
  if (markerAt < 0) return "";
  return prompt.slice(markerAt + USER_MESSAGE_MARKER.length).trim();
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0]?.trim() ?? "";
}

function slugify(value: string): string {
  const slug = firstLine(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-");
  return slug.length > 0 ? slug : "mock-change";
}

function valueForKey(key: string, message: string): string {
  switch (key) {
    // The skill / prompt-assist round trip: echoing the card body keeps board
    // skills observable and idempotent instead of replacing work with filler.
    case "text":
      return message.length > 0 ? message : "Mock agent reply.";
    case "reply":
      return "Mock agent: no board actions taken.";
    case "branch":
      return slugify(message);
    case "subject":
    case "title":
      return firstLine(message).slice(0, 72) || "Mock agent change";
    case "body":
      return message;
    default:
      return firstLine(message) || "Mock agent reply.";
  }
}

/**
 * Build the mock's reply for a prompt. Returns a JSON string when the prompt
 * declared a response shape, and the plain echo otherwise — an interactive
 * thread turn has no shape line and wants prose, not JSON.
 */
export function deriveMockReply(prompt: string): string {
  const keys = parseResponseShapeKeys(prompt);
  const message = extractUserMessage(prompt);
  if (keys.length === 0) {
    return message.length > 0 ? `Mock agent received: ${firstLine(message)}` : "hello from mock";
  }
  const payload: Record<string, unknown> = {};
  for (const key of keys) {
    payload[key.name] = key.isArray ? [] : valueForKey(key.name, message);
  }
  return JSON.stringify(payload);
}
