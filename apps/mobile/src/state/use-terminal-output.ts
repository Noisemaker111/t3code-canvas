import {
  retainedTerminalOutput,
  subscribeTerminalOutput,
  terminalOutputKey,
} from "@t3tools/client-runtime/state/terminal";
import { useEffect, useRef, useState } from "react";

/**
 * How long chunks pile up before the screen is told. The native surface takes a
 * whole buffer rather than a stream, so every chunk that reaches React is a
 * re-render of the terminal screen; a shell printing a build log produces
 * hundreds a second and none of them are individually worth a frame.
 */
const COALESCE_MS = 50;

/**
 * The scrollback for one shell, out of the terminal output mailbox.
 *
 * Output does not travel through reactive state — see
 * `@t3tools/client-runtime/state/terminalOutput` — so a surface that wants the
 * whole buffer subscribes for it here instead of reading it off the session.
 */
export function useTerminalOutputBuffer(
  threadId: string | null,
  terminalId: string | null,
): string {
  const [buffer, setBuffer] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (threadId === null || terminalId === null) {
      setBuffer("");
      return;
    }
    const key = terminalOutputKey({ threadId, terminalId });
    const flush = () => {
      timerRef.current = null;
      setBuffer(retainedTerminalOutput(key));
    };
    flush();
    const unsubscribe = subscribeTerminalOutput(key, (chunk) => {
      // A replaced buffer is shown at once; appends wait out the window.
      if (chunk === null) {
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        flush();
        return;
      }
      if (timerRef.current !== null) return;
      timerRef.current = setTimeout(flush, COALESCE_MS);
    });
    return () => {
      unsubscribe();
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [terminalId, threadId]);

  return buffer;
}
