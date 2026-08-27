/**
 * The keys a soft keyboard does not have.
 *
 * A phone keyboard has letters and no way to interrupt a process, leave insert
 * mode, complete a path, or walk shell history — so on a touch device the
 * terminal is read-only in practice. This is the row that fixes that, and the
 * byte each key sends.
 *
 * @module terminal-key-row
 */

export interface TerminalRowKey {
  readonly id: string;
  readonly label: string;
  /** What to send, or null for `ctrl`, which arms the next key instead. */
  readonly data: string | null;
}

export const TERMINAL_ROW_KEYS: ReadonlyArray<TerminalRowKey> = [
  { id: "esc", label: "esc", data: "\u001b" },
  { id: "tab", label: "tab", data: "\t" },
  { id: "ctrl", label: "ctrl", data: null },
  { id: "up", label: "↑", data: "\u001b[A" },
  { id: "down", label: "↓", data: "\u001b[B" },
  { id: "left", label: "←", data: "\u001b[D" },
  { id: "right", label: "→", data: "\u001b[C" },
];

/**
 * The control byte for a character, or null when there is no such thing.
 *
 * `ctrl` on a phone is sticky: it arms, the next character the keyboard sends
 * is folded into a control byte here, and it disarms. Letters fold by clearing
 * the top three bits, which is the same rule a hardware terminal uses, and the
 * six punctuation keys that have control codes are spelled out because the
 * arithmetic for them is not the letter rule.
 */
export function terminalControlByte(character: string): string | null {
  if (character.length !== 1) return null;
  const upper = character.toUpperCase();
  const code = upper.codePointAt(0);
  if (code === undefined) return null;
  if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code & 0x1f);
  switch (character) {
    case "@":
      return "\u0000";
    case "[":
      return "\u001b";
    case "\\":
      return "\u001c";
    case "]":
      return "\u001d";
    case "^":
      return "\u001e";
    case "_":
    case "?":
      return "\u001f";
    case " ":
      return "\u0000";
    default:
      return null;
  }
}
