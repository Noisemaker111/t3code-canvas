import { useAtomValue } from "@effect/atom-react";
import { FitAddon } from "@xterm/addon-fit";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  Plus,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TerminalSquare,
  Trash2,
  XIcon,
} from "lucide-react";
import {
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import { Terminal, type ITheme } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { useOpenInPreferredEditor } from "../editorPreferences";
import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
  resolveWrappedTerminalLinkRange,
  wrappedTerminalLinkRangeIntersectsBufferLine,
} from "../terminal-links";
import {
  isDiffToggleShortcut,
  isTerminalClearShortcut,
  isTerminalCloseShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  isTerminalSplitVerticalShortcut,
  isTerminalToggleShortcut,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
} from "../keybindings";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "../types";
import { readLocalApi } from "~/localApi";
import {
  INITIAL_TERMINAL_INPUT_TRACKER_STATE,
  type TerminalInputTrackerState,
  appendTerminalHistory,
  applyTerminalInputData,
  isSuggestionAcceptKey,
  readStoredTerminalHistory,
  terminalSuggestionSuffix,
  writeStoredTerminalHistory,
} from "../terminal-autosuggest";
import { buildTerminalContextMenuItems } from "../terminal-context-menu";
import { TERMINAL_ROW_KEYS, terminalControlByte } from "../terminal-key-row";
import { useMediaQuery } from "../hooks/useMediaQuery";
import {
  retainedTerminalOutput,
  subscribeTerminalOutput,
  terminalOutputKey,
} from "@t3tools/client-runtime/state/terminal";
import { useAttachedTerminalSession } from "../state/terminalSessions";
import { serverEnvironment } from "../state/server";
import { previewEnvironment } from "../state/preview";
import { terminalEnvironment } from "../state/terminal";
import { openTerminalLinkInPreview } from "./preview/openTerminalLinkInPreview";
import { useAtomCommand } from "../state/use-atom-command";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;

function maxDrawerHeight(): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO));
}

function clampDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  const maxHeight = maxDrawerHeight();
  return Math.min(Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT), maxHeight);
}

function writeSystemMessage(terminal: Terminal, message: string): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}

function writeTerminalBuffer(terminal: Terminal, buffer: string): void {
  terminal.write("\u001bc");
  if (buffer.length > 0) {
    terminal.write(buffer);
  }
}

function fitTerminalSafely(fitAddon: FitAddon): boolean {
  try {
    fitAddon.fit();
    return true;
  } catch {
    return false;
  }
}

function loadWebglRendererSafely(terminal: Terminal): void {
  try {
    const addon = new WebglAddon();
    // On context loss, dispose so xterm falls back to the DOM renderer.
    addon.onContextLoss(() => {
      addon.dispose();
    });
    terminal.loadAddon(addon);
  } catch {
    // WebGL unavailable (headless, software rendering, exhausted contexts).
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

let sharedTerminalCommandHistory: readonly string[] | null = null;

function getTerminalCommandHistory(): readonly string[] {
  sharedTerminalCommandHistory ??= readStoredTerminalHistory(safeLocalStorage());
  return sharedTerminalCommandHistory;
}

function recordTerminalCommand(command: string): void {
  const next = appendTerminalHistory(getTerminalCommandHistory(), command);
  if (next !== sharedTerminalCommandHistory) {
    sharedTerminalCommandHistory = next;
    writeStoredTerminalHistory(safeLocalStorage(), next);
  }
}

function runtimeEnvSignature(runtimeEnv: Record<string, string> | undefined): string {
  if (!runtimeEnv) return "";
  return JSON.stringify(
    Object.entries(runtimeEnv)
      .filter(([key, value]) => key.length > 0 && typeof value === "string")
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)),
  );
}

function normalizeComputedColor(value: string | null | undefined, fallback: string): string {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return fallback;
  }
  return value ?? fallback;
}

function terminalThemeFromApp(mountElement?: HTMLElement | null): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const fallbackBackground = isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)";
  const fallbackForeground = isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)";
  const drawerSurface =
    mountElement?.closest(".thread-terminal-drawer") ??
    document.querySelector(".thread-terminal-drawer") ??
    document.body;
  const drawerStyles = getComputedStyle(drawerSurface);
  const bodyStyles = getComputedStyle(document.body);
  const background = normalizeComputedColor(
    drawerStyles.backgroundColor,
    normalizeComputedColor(bodyStyles.backgroundColor, fallbackBackground),
  );
  const foreground = normalizeComputedColor(
    drawerStyles.color,
    normalizeComputedColor(bodyStyles.color, fallbackForeground),
  );

  if (isDark) {
    return {
      background,
      foreground,
      cursor: "rgb(180, 203, 255)",
      selectionBackground: "rgba(180, 203, 255, 0.25)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
      black: "rgb(24, 30, 38)",
      red: "rgb(255, 122, 142)",
      green: "rgb(134, 231, 149)",
      yellow: "rgb(244, 205, 114)",
      blue: "rgb(137, 190, 255)",
      magenta: "rgb(208, 176, 255)",
      cyan: "rgb(124, 232, 237)",
      white: "rgb(210, 218, 230)",
      brightBlack: "rgb(110, 120, 136)",
      brightRed: "rgb(255, 168, 180)",
      brightGreen: "rgb(176, 245, 186)",
      brightYellow: "rgb(255, 224, 149)",
      brightBlue: "rgb(174, 210, 255)",
      brightMagenta: "rgb(229, 203, 255)",
      brightCyan: "rgb(167, 244, 247)",
      brightWhite: "rgb(244, 247, 252)",
    };
  }

  return {
    background,
    foreground,
    cursor: "rgb(38, 56, 78)",
    selectionBackground: "rgba(37, 63, 99, 0.2)",
    scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
    scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
    scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
    black: "rgb(44, 53, 66)",
    red: "rgb(191, 70, 87)",
    green: "rgb(60, 126, 86)",
    yellow: "rgb(146, 112, 35)",
    blue: "rgb(72, 102, 163)",
    magenta: "rgb(132, 86, 149)",
    cyan: "rgb(53, 127, 141)",
    white: "rgb(210, 215, 223)",
    brightBlack: "rgb(112, 123, 140)",
    brightRed: "rgb(212, 95, 112)",
    brightGreen: "rgb(85, 148, 111)",
    brightYellow: "rgb(173, 133, 45)",
    brightBlue: "rgb(91, 124, 194)",
    brightMagenta: "rgb(153, 107, 172)",
    brightCyan: "rgb(70, 149, 164)",
    brightWhite: "rgb(236, 240, 246)",
  };
}

interface TerminalViewportProps {
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  focusRequestId: number;
  autoFocus: boolean;
  resizeEpoch: number;
  drawerHeight: number;
  keybindings: ResolvedKeybindingsConfig;
}

interface TerminalLaunchLocation {
  readonly cwd: string;
  readonly worktreePath?: string | null;
  readonly runtimeEnv?: Record<string, string>;
}

export function TerminalViewport({
  threadRef,
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  worktreePath,
  runtimeEnv,
  onSessionExited,
  onAddTerminalContext,
  focusRequestId,
  autoFocus,
  resizeEpoch,
  drawerHeight,
  keybindings,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const environmentId = threadRef.environmentId;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    environmentId,
    serverConfig?.availableEditors ?? [],
  );
  const openTerminalPath = useEffectEvent((target: string) => openInPreferredEditor(target));
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const runTerminalWrite = useAtomCommand(terminalEnvironment.write, {
    reportFailure: false,
  });
  const runTerminalResize = useAtomCommand(terminalEnvironment.resize, {
    reportFailure: false,
  });
  const hasHandledExitRef = useRef(false);
  const contextMenuOpenRef = useRef(false);
  const inputTrackerRef = useRef<TerminalInputTrackerState>(INITIAL_TERMINAL_INPUT_TRACKER_STATE);
  const suggestionSuffixRef = useRef<string | null>(null);
  const keybindingsRef = useRef(keybindings);
  const touch = useMediaQuery({ pointer: "coarse" });
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const ctrlArmedRef = useRef(false);
  const armCtrl = useCallback((armed: boolean) => {
    ctrlArmedRef.current = armed;
    setCtrlArmed(armed);
  }, []);
  const runtimeEnvKey = useMemo(() => runtimeEnvSignature(runtimeEnv), [runtimeEnv]);
  const handleSessionExited = useEffectEvent(() => {
    onSessionExited();
  });
  const handleAddTerminalContext = useEffectEvent((selection: TerminalContextSelection) => {
    onAddTerminalContext(selection);
  });
  const readTerminalLabel = useEffectEvent(() => terminalLabel);
  const terminalSession = useAttachedTerminalSession({
    environmentId,
    terminal: {
      threadId,
      terminalId,
      cwd,
      ...(worktreePath !== undefined ? { worktreePath } : {}),
      ...(runtimeEnv ? { env: runtimeEnv } : {}),
    },
  });
  const sendRowKey = useEffectEvent((data: string) => {
    const terminal = terminalRef.current;
    if (terminal === null) return;
    void runTerminalWrite({ environmentId, input: { threadId, terminalId, data } });
    terminal.focus();
  });
  const writeTerminal = useEffectEvent((data: string) =>
    runTerminalWrite({
      environmentId,
      input: { threadId, terminalId, data },
    }),
  );
  const resizeTerminal = useEffectEvent((cols: number, rows: number) =>
    runTerminalResize({
      environmentId,
      input: { threadId, terminalId, cols, rows },
    }),
  );
  const terminalError = terminalSession.error;
  const terminalStatus = terminalSession.status;
  const terminalVersion = terminalSession.version;
  const previousSessionRef = useRef({
    error: terminalError,
    status: terminalStatus,
    version: terminalVersion,
  });

  useEffect(() => {
    keybindingsRef.current = keybindings;
  }, [keybindings]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    const localApi = readLocalApi();

    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1,
      fontSize: 12,
      scrollback: 5_000,
      fontFamily:
        '"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace',
      theme: terminalThemeFromApp(mount),
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    loadWebglRendererSafely(terminal);
    fitTerminalSafely(fitAddon);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    previousSessionRef.current = {
      status: "closed",
      error: null,
      version: 0,
    };
    inputTrackerRef.current = INITIAL_TERMINAL_INPUT_TRACKER_STATE;
    suggestionSuffixRef.current = null;

    const ghostElement = document.createElement("div");
    ghostElement.setAttribute("aria-hidden", "true");
    ghostElement.className =
      "pointer-events-none absolute z-10 hidden select-none whitespace-pre opacity-45";
    mount.appendChild(ghostElement);

    const hideSuggestionGhost = () => {
      suggestionSuffixRef.current = null;
      ghostElement.classList.add("hidden");
    };

    const refreshSuggestionGhost = () => {
      const activeTerminal = terminalRef.current;
      const tracker = inputTrackerRef.current;
      if (!activeTerminal || !tracker.tracking) {
        hideSuggestionGhost();
        return;
      }
      const suffix = terminalSuggestionSuffix(getTerminalCommandHistory(), tracker.line);
      if (suffix === null) {
        hideSuggestionGhost();
        return;
      }
      const buffer = activeTerminal.buffer.active;
      if (buffer.viewportY !== buffer.baseY) {
        hideSuggestionGhost();
        return;
      }
      const screen = mount.querySelector(".xterm-screen");
      if (
        !(screen instanceof HTMLElement) ||
        activeTerminal.cols <= 0 ||
        activeTerminal.rows <= 0
      ) {
        hideSuggestionGhost();
        return;
      }
      const screenRect = screen.getBoundingClientRect();
      const mountRect = mount.getBoundingClientRect();
      const cellWidth = screenRect.width / activeTerminal.cols;
      const cellHeight = screenRect.height / activeTerminal.rows;
      const remainingCols = activeTerminal.cols - buffer.cursorX;
      if (!Number.isFinite(cellWidth) || cellWidth <= 0 || cellHeight <= 0 || remainingCols <= 0) {
        hideSuggestionGhost();
        return;
      }
      suggestionSuffixRef.current = suffix;
      ghostElement.textContent = suffix.slice(0, remainingCols);
      ghostElement.style.left = `${screenRect.left - mountRect.left + buffer.cursorX * cellWidth}px`;
      ghostElement.style.top = `${screenRect.top - mountRect.top + buffer.cursorY * cellHeight}px`;
      ghostElement.style.fontFamily = String(terminal.options.fontFamily ?? "monospace");
      ghostElement.style.fontSize = `${terminal.options.fontSize ?? 12}px`;
      ghostElement.style.lineHeight = `${cellHeight}px`;
      ghostElement.classList.remove("hidden");
    };

    const readSelectionContext = (): {
      clipboardText: string;
      selection: TerminalContextSelection;
    } | null => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal || !activeTerminal.hasSelection()) {
        return null;
      }
      const selectionText = activeTerminal.getSelection();
      const selectionPosition = activeTerminal.getSelectionPosition();
      const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
      if (!selectionPosition || normalizedText.length === 0) {
        return null;
      }
      const lineStart = selectionPosition.start.y + 1;
      const lineCount = normalizedText.split("\n").length;
      const lineEnd = Math.max(lineStart, lineStart + lineCount - 1);
      return {
        clipboardText: selectionText,
        selection: {
          terminalId,
          terminalLabel: readTerminalLabel(),
          lineStart,
          lineEnd,
          text: normalizedText,
        },
      };
    };

    const sendTerminalInput = async (data: string, fallbackError: string) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      const result = await writeTerminal(data);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallbackError);
      }
    };

    const showTerminalContextMenu = async (position: { x: number; y: number }) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal || !localApi || contextMenuOpenRef.current) {
        return;
      }
      const selectionContext = readSelectionContext();
      const canPaste =
        typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function";
      contextMenuOpenRef.current = true;
      const clicked = await localApi.contextMenu
        .show(
          buildTerminalContextMenuItems({ hasSelection: selectionContext !== null, canPaste }),
          position,
        )
        .finally(() => {
          contextMenuOpenRef.current = false;
        });
      const latestTerminal = terminalRef.current;
      if (clicked === null || !latestTerminal) {
        return;
      }
      switch (clicked) {
        case "add-to-chat":
          if (selectionContext) {
            handleAddTerminalContext(selectionContext.selection);
            latestTerminal.clearSelection();
          }
          latestTerminal.focus();
          return;
        case "copy":
          if (selectionContext) {
            try {
              await writeTextToClipboard(selectionContext.clipboardText, "terminal selection");
            } catch (error) {
              writeSystemMessage(
                latestTerminal,
                error instanceof Error ? error.message : "Unable to copy terminal selection",
              );
            }
          }
          terminalRef.current?.focus();
          return;
        case "paste":
          try {
            const text = await navigator.clipboard.readText();
            const pasteTarget = terminalRef.current;
            if (text.length > 0 && pasteTarget) {
              pasteTarget.paste(text);
            }
          } catch (error) {
            writeSystemMessage(
              latestTerminal,
              error instanceof Error ? error.message : "Unable to read the clipboard",
            );
          }
          terminalRef.current?.focus();
          return;
        case "select-all":
          latestTerminal.selectAll();
          return;
        case "clear":
          latestTerminal.clear();
          void sendTerminalInput("\u000c", "Failed to clear terminal");
          latestTerminal.focus();
          return;
      }
    };

    terminal.attachCustomKeyEventHandler((event) => {
      // `ctrl` on the touch row arms rather than sends: the next character the
      // soft keyboard produces is folded into its control byte here, because a
      // phone keyboard has no modifier to hold down while typing one.
      if (event.type === "keydown" && ctrlArmedRef.current) {
        const byte = terminalControlByte(event.key);
        armCtrl(false);
        if (byte !== null) {
          event.preventDefault();
          event.stopPropagation();
          void sendTerminalInput(byte, "Failed to send control key");
          return false;
        }
      }

      // The clipboard belongs to the browser, never the pty. Ctrl/Cmd+V used to
      // fall through to xterm's key mapping, which sends the ^V control byte to
      // the shell; returning false *without* preventDefault lets the native
      // paste reach xterm's textarea, and its paste handler does the rest.
      // Ctrl/Cmd+C with a selection copies it — an interrupt with text selected
      // is a copy everywhere else on the platform.
      if (event.type === "keydown" && (event.ctrlKey || event.metaKey) && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === "v") return false;
        if (key === "c" && terminalRef.current?.hasSelection() === true) {
          event.preventDefault();
          event.stopPropagation();
          const copyTarget = terminalRef.current;
          void writeTextToClipboard(copyTarget.getSelection(), "terminal selection").catch(
            (error: unknown) => {
              writeSystemMessage(
                copyTarget,
                error instanceof Error ? error.message : "Unable to copy terminal selection",
              );
            },
          );
          copyTarget.clearSelection();
          return false;
        }
      }

      if (isSuggestionAcceptKey(event) && suggestionSuffixRef.current !== null) {
        const suffix = suggestionSuffixRef.current;
        event.preventDefault();
        event.stopPropagation();
        inputTrackerRef.current = {
          line: inputTrackerRef.current.line + suffix,
          tracking: true,
        };
        suggestionSuffixRef.current = null;
        ghostElement.classList.add("hidden");
        void sendTerminalInput(suffix, "Failed to insert suggestion");
        return false;
      }

      const currentKeybindings = keybindingsRef.current;
      const options = { context: { terminalFocus: true, terminalOpen: true } };
      if (
        isTerminalToggleShortcut(event, currentKeybindings, options) ||
        isTerminalSplitShortcut(event, currentKeybindings, options) ||
        isTerminalSplitVerticalShortcut(event, currentKeybindings, options) ||
        isTerminalNewShortcut(event, currentKeybindings, options) ||
        isTerminalCloseShortcut(event, currentKeybindings, options) ||
        isDiffToggleShortcut(event, currentKeybindings, options)
      ) {
        return false;
      }

      const navigationData = terminalNavigationShortcutData(event);
      if (navigationData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput(navigationData, "Failed to move cursor");
        return false;
      }

      const deleteData = terminalDeleteShortcutData(event);
      if (deleteData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput(deleteData, "Failed to delete terminal input");
        return false;
      }

      if (!isTerminalClearShortcut(event)) return true;
      event.preventDefault();
      event.stopPropagation();
      void sendTerminalInput("\u000c", "Failed to clear terminal");
      return false;
    });

    const terminalLinksDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) {
          callback(undefined);
          return;
        }

        const wrappedLine = collectWrappedTerminalLinkLine(bufferLineNumber, (bufferLineIndex) =>
          activeTerminal.buffer.active.getLine(bufferLineIndex),
        );
        if (!wrappedLine) {
          callback(undefined);
          return;
        }

        const links = extractTerminalLinks(wrappedLine.text)
          .map((match) => ({
            match,
            range: resolveWrappedTerminalLinkRange(wrappedLine, match),
          }))
          .filter(({ range }) =>
            wrappedTerminalLinkRangeIntersectsBufferLine(range, bufferLineNumber),
          );
        if (links.length === 0) {
          callback(undefined);
          return;
        }

        callback(
          links.map(({ match, range }) => ({
            text: match.text,
            range,
            activate: (event: MouseEvent) => {
              if (!isTerminalLinkActivation(event)) return;

              const latestTerminal = terminalRef.current;
              if (!latestTerminal) return;

              if (match.kind === "url") {
                if (!localApi) {
                  writeSystemMessage(
                    latestTerminal,
                    "Opening links is unavailable in this browser.",
                  );
                  return;
                }
                const fallbackToBrowser = () => {
                  void localApi.shell.openExternal(match.text).catch((error: unknown) => {
                    writeSystemMessage(
                      latestTerminal,
                      error instanceof Error ? error.message : "Unable to open link",
                    );
                  });
                };
                void openTerminalLinkInPreview({
                  url: match.text,
                  position: { x: event.clientX, y: event.clientY },
                  threadRef,
                  openPreview,
                  localApi,
                  fallbackToBrowser,
                });
                return;
              }

              const target = resolvePathLinkTarget(match.text, cwd);
              void (async () => {
                const result = await openTerminalPath(target);
                if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
                  return;
                }
                const error = squashAtomCommandFailure(result);
                writeSystemMessage(
                  latestTerminal,
                  error instanceof Error ? error.message : "Unable to open path",
                );
              })();
            },
          })),
        );
      },
    });

    const inputDisposable = terminal.onData((data) => {
      const step = applyTerminalInputData(inputTrackerRef.current, data);
      inputTrackerRef.current = step.state;
      for (const command of step.committed) {
        recordTerminalCommand(command);
      }
      refreshSuggestionGhost();
      void (async () => {
        const result = await writeTerminal(data);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        writeSystemMessage(
          terminal,
          error instanceof Error ? error.message : "Terminal write failed",
        );
      })();
    });

    const writeParsedDisposable = terminal.onWriteParsed(() => {
      refreshSuggestionGhost();
    });
    const scrollDisposable = terminal.onScroll(() => {
      refreshSuggestionGhost();
    });
    const terminalResizeDisposable = terminal.onResize(() => {
      refreshSuggestionGhost();
    });

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      void showTerminalContextMenu({ x: event.clientX, y: event.clientY });
    };
    mount.addEventListener("contextmenu", handleContextMenu);

    // iOS never fires `contextmenu`, which left touch devices with no paste
    // path at all. A long press opens the same menu the right click does.
    let longPressTimer = 0;
    let longPressAt: { x: number; y: number } | null = null;
    const cancelLongPress = () => {
      if (longPressTimer !== 0) {
        window.clearTimeout(longPressTimer);
        longPressTimer = 0;
      }
      longPressAt = null;
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      longPressAt = { x: event.clientX, y: event.clientY };
      window.clearTimeout(longPressTimer);
      longPressTimer = window.setTimeout(() => {
        longPressTimer = 0;
        const at = longPressAt;
        longPressAt = null;
        if (at !== null) void showTerminalContextMenu(at);
      }, 500);
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (longPressAt === null || event.pointerType !== "touch") return;
      if (Math.hypot(event.clientX - longPressAt.x, event.clientY - longPressAt.y) > 12) {
        cancelLongPress();
      }
    };
    mount.addEventListener("pointerdown", handlePointerDown);
    mount.addEventListener("pointermove", handlePointerMove);
    mount.addEventListener("pointerup", cancelLongPress);
    mount.addEventListener("pointercancel", cancelLongPress);

    // The panel is resized on the canvas, split, focused to full window —
    // none of which the drawer-height plumbing sees. The element's own box is
    // the one truth about how big the terminal is, so fit to it directly, and
    // the pty only hears about it when the grid actually changed.
    let fitFrame = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (fitFrame !== 0) return;
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = 0;
        const activeTerminal = terminalRef.current;
        const activeFitAddon = fitAddonRef.current;
        if (!activeTerminal || !activeFitAddon) return;
        const wasAtBottom =
          activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY;
        const cols = activeTerminal.cols;
        const rows = activeTerminal.rows;
        if (!fitTerminalSafely(activeFitAddon)) return;
        if (wasAtBottom) activeTerminal.scrollToBottom();
        if (activeTerminal.cols !== cols || activeTerminal.rows !== rows) {
          void resizeTerminal(activeTerminal.cols, activeTerminal.rows);
        }
      });
    });
    resizeObserver.observe(mount);

    const themeObserver = new MutationObserver(() => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      activeTerminal.options.theme = terminalThemeFromApp(containerRef.current);
      activeTerminal.refresh(0, activeTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const fitTimer = window.setTimeout(() => {
      const activeTerminal = terminalRef.current;
      const activeFitAddon = fitAddonRef.current;
      if (!activeTerminal || !activeFitAddon) return;
      const wasAtBottom =
        activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY;
      fitTerminalSafely(activeFitAddon);
      if (wasAtBottom) {
        activeTerminal.scrollToBottom();
      }
      void resizeTerminal(activeTerminal.cols, activeTerminal.rows);
    }, 30);

    return () => {
      window.clearTimeout(fitTimer);
      if (fitFrame !== 0) window.cancelAnimationFrame(fitFrame);
      resizeObserver.disconnect();
      cancelLongPress();
      inputDisposable.dispose();
      writeParsedDisposable.dispose();
      scrollDisposable.dispose();
      terminalResizeDisposable.dispose();
      terminalLinksDisposable.dispose();
      mount.removeEventListener("contextmenu", handleContextMenu);
      mount.removeEventListener("pointerdown", handlePointerDown);
      mount.removeEventListener("pointermove", handlePointerMove);
      mount.removeEventListener("pointerup", cancelLongPress);
      mount.removeEventListener("pointercancel", cancelLongPress);
      ghostElement.remove();
      themeObserver.disconnect();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
    // autoFocus is intentionally omitted;
    // it is only read at mount time and must not trigger terminal teardown/recreation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, environmentId, runtimeEnvKey, terminalId, threadId, worktreePath]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const current = {
      error: terminalError,
      status: terminalStatus,
      version: terminalVersion,
    };
    if (!terminal) {
      previousSessionRef.current = current;
      return;
    }

    const previous = previousSessionRef.current;
    if (current.version === previous.version) {
      return;
    }

    if (current.error !== null && current.error !== previous.error) {
      writeSystemMessage(terminal, current.error);
    }

    if (current.status === "running") {
      hasHandledExitRef.current = false;
    } else if (
      (current.status === "closed" || current.status === "exited") &&
      current.status !== previous.status &&
      !hasHandledExitRef.current
    ) {
      hasHandledExitRef.current = true;
      writeSystemMessage(
        terminal,
        current.status === "closed" ? "Terminal closed" : "Process exited",
      );
      window.setTimeout(() => {
        if (hasHandledExitRef.current) {
          handleSessionExited();
        }
      }, 0);
    }

    if (previous.version === 0 && autoFocus) {
      window.requestAnimationFrame(() => {
        terminal.focus();
      });
    }
    previousSessionRef.current = current;
  }, [autoFocus, terminalError, terminalStatus, terminalVersion]);

  /**
   * Output goes emulator-bound without passing through React: the mailbox hands
   * over each chunk as it lands, and the retained scrollback is replayed on
   * mount, for a pane opened after the shell had already been running.
   *
   * A `null` chunk is the mailbox saying the retained buffer was replaced
   * rather than extended — attach, restart, clear — so the pane starts over
   * instead of appending a second copy of the scrollback it already shows.
   */
  useEffect(() => {
    const key = terminalOutputKey({ threadId, terminalId });
    const replay = () => {
      const terminal = terminalRef.current;
      if (terminal === null) return;
      writeTerminalBuffer(terminal, retainedTerminalOutput(key));
      terminal.clearSelection();
    };
    replay();
    return subscribeTerminalOutput(key, (chunk) => {
      const terminal = terminalRef.current;
      if (terminal === null) return;
      if (chunk === null) replay();
      else terminal.write(chunk);
    });
  }, [cwd, environmentId, runtimeEnvKey, terminalId, threadId, worktreePath]);

  useEffect(() => {
    if (!autoFocus) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const frame = window.requestAnimationFrame(() => {
      terminal.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [autoFocus, focusRequestId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    const frame = window.requestAnimationFrame(() => {
      fitTerminalSafely(fitAddon);
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
      void resizeTerminal(terminal.cols, terminal.rows);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [drawerHeight, environmentId, resizeEpoch, terminalId, threadId]);
  return (
    <div className="relative flex h-full w-full min-h-0 flex-col rounded-[4px] bg-background">
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden" />
      {touch ? (
        <div
          className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border/70 px-1 py-1"
          // A press must not take focus off the terminal: losing it closes the
          // soft keyboard, which is the thing this row exists to supplement.
          onPointerDown={(event) => event.preventDefault()}
        >
          {TERMINAL_ROW_KEYS.map((key) => (
            <button
              key={key.id}
              type="button"
              aria-pressed={key.data === null ? ctrlArmed : undefined}
              className={cn(
                "min-w-9 shrink-0 rounded-md border border-border/70 px-2 py-1.5 font-mono text-xs text-foreground/90 active:bg-muted",
                key.data === null && ctrlArmed && "border-primary bg-primary/15 text-primary",
              )}
              onClick={() => {
                if (key.data === null) {
                  armCtrl(!ctrlArmedRef.current);
                  terminalRef.current?.focus();
                  return;
                }
                armCtrl(false);
                sendRowKey(key.data);
              }}
            >
              {key.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface ThreadTerminalDrawerProps {
  mode?: "drawer" | "panel";
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  visible?: boolean;
  height: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  focusRequestId: number;
  onSplitTerminal: () => void;
  onSplitTerminalVertical: () => void;
  onNewTerminal: () => void;
  splitShortcutLabel?: string | undefined;
  splitVerticalShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  keybindings: ResolvedKeybindingsConfig;
  /** Prefer server-provided tab titles when present (e.g. active subprocess name). */
  terminalLabelsById?: ReadonlyMap<string, string>;
  /**
   * Dragging a sidebar terminal out of the drawer and releasing beyond it
   * lands here with the release point in client pixels — the canvas terminal
   * panel uses it to open that shell as its own pane where it was dropped.
   */
  onTearOffTerminal?: (terminalId: string, point: { x: number; y: number }) => void;
  /** Prefer per-session launch locations when the server already knows a terminal. */
  terminalLaunchLocationsById?: ReadonlyMap<string, TerminalLaunchLocation>;
}

interface TerminalActionButtonProps {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactNode;
}

function TerminalActionButton({ label, className, onClick, children }: TerminalActionButtonProps) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={<button type="button" className={className} onClick={onClick} aria-label={label} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="bottom"
        sideOffset={6}
        align="center"
        className="pointer-events-none select-none"
      >
        {label}
      </PopoverPopup>
    </Popover>
  );
}

export default function ThreadTerminalDrawer({
  mode = "drawer",
  threadRef,
  threadId,
  cwd,
  worktreePath,
  runtimeEnv,
  visible = true,
  height,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  focusRequestId,
  onSplitTerminal,
  onSplitTerminalVertical,
  onNewTerminal,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  onActiveTerminalChange,
  onCloseTerminal,
  onHeightChange,
  onAddTerminalContext,
  keybindings,
  terminalLabelsById,
  terminalLaunchLocationsById,
  onTearOffTerminal,
}: ThreadTerminalDrawerProps) {
  const isPanel = mode === "panel";
  const controlledDrawerHeight = clampDrawerHeight(height);
  const [drawerHeightState, setDrawerHeightState] = useState(() => ({
    threadId,
    height: controlledDrawerHeight,
  }));
  const drawerHeight =
    drawerHeightState.threadId === threadId ? drawerHeightState.height : controlledDrawerHeight;
  const setDrawerHeight = useCallback(
    (update: SetStateAction<number>) => {
      setDrawerHeightState((current) => {
        const currentHeight =
          current.threadId === threadId ? current.height : controlledDrawerHeight;
        const nextHeight = typeof update === "function" ? update(currentHeight) : update;
        return nextHeight === currentHeight && current.threadId === threadId
          ? current
          : { threadId, height: nextHeight };
      });
    },
    [controlledDrawerHeight, threadId],
  );
  const setDrawerHeightFromWindowResize = useEffectEvent((nextHeight: number) => {
    setDrawerHeight(nextHeight);
  });
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const drawerHeightRef = useRef(drawerHeight);
  const lastSyncedHeightRef = useRef(controlledDrawerHeight);
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);
  const drawerElementRef = useRef<HTMLElement | null>(null);
  const tearStateRef = useRef<{
    terminalId: string;
    pointerId: number;
    origin: { x: number; y: number };
    moved: boolean;
  } | null>(null);
  const suppressRowClickRef = useRef(false);
  const [tearingTerminalId, setTearingTerminalId] = useState<string | null>(null);

  const beginTearOff = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, terminalId: string) => {
      if (!onTearOffTerminal) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      tearStateRef.current = {
        terminalId,
        pointerId: event.pointerId,
        origin: { x: event.clientX, y: event.clientY },
        moved: false,
      };
    },
    [onTearOffTerminal],
  );
  const moveTearOff = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const state = tearStateRef.current;
    if (state === null || state.pointerId !== event.pointerId || state.moved) return;
    if (Math.hypot(event.clientX - state.origin.x, event.clientY - state.origin.y) > 8) {
      state.moved = true;
      setTearingTerminalId(state.terminalId);
    }
  }, []);
  const endTearOff = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = tearStateRef.current;
      if (state === null || state.pointerId !== event.pointerId) return;
      tearStateRef.current = null;
      setTearingTerminalId(null);
      if (!state.moved || !onTearOffTerminal) return;
      suppressRowClickRef.current = true;
      // Releasing back over the drawer is a cancel, not a drop.
      const bounds = drawerElementRef.current?.getBoundingClientRect();
      const inside =
        bounds !== undefined &&
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom;
      if (!inside) onTearOffTerminal(state.terminalId, { x: event.clientX, y: event.clientY });
    },
    [onTearOffTerminal],
  );
  const suppressTearOffClick = useCallback((event: ReactMouseEvent) => {
    if (!suppressRowClickRef.current) return;
    suppressRowClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const normalizedTerminalIds = useMemo(() => {
    const normalizedIds: string[] = [];
    const seen = new Set<string>();
    for (const id of terminalIds) {
      const trimmedId = id.trim();
      if (trimmedId.length === 0 || seen.has(trimmedId)) continue;
      seen.add(trimmedId);
      normalizedIds.push(trimmedId);
    }
    return normalizedIds;
  }, [terminalIds]);

  const resolvedActiveTerminalId =
    normalizedTerminalIds.length === 0
      ? ""
      : normalizedTerminalIds.includes(activeTerminalId)
        ? activeTerminalId
        : (normalizedTerminalIds[0] ?? "");

  const resolvedTerminalGroups = useMemo(() => {
    if (normalizedTerminalIds.length === 0) {
      return [];
    }
    const validTerminalIdSet = new Set(normalizedTerminalIds);
    const assignedTerminalIds = new Set<string>();
    const usedGroupIds = new Set<string>();
    const nextGroups: ThreadTerminalGroup[] = [];

    const assignUniqueGroupId = (groupId: string): string => {
      if (!usedGroupIds.has(groupId)) {
        usedGroupIds.add(groupId);
        return groupId;
      }
      let suffix = 2;
      while (usedGroupIds.has(`${groupId}-${suffix}`)) {
        suffix += 1;
      }
      const uniqueGroupId = `${groupId}-${suffix}`;
      usedGroupIds.add(uniqueGroupId);
      return uniqueGroupId;
    };

    for (const terminalGroup of terminalGroups) {
      const nextTerminalIds: string[] = [];
      const seenGroupTerminalIds = new Set<string>();
      for (const id of terminalGroup.terminalIds) {
        const terminalId = id.trim();
        if (terminalId.length === 0) continue;
        if (seenGroupTerminalIds.has(terminalId)) continue;
        seenGroupTerminalIds.add(terminalId);
        if (!validTerminalIdSet.has(terminalId)) continue;
        if (assignedTerminalIds.has(terminalId)) continue;
        nextTerminalIds.push(terminalId);
      }
      if (nextTerminalIds.length === 0) continue;

      for (const terminalId of nextTerminalIds) {
        assignedTerminalIds.add(terminalId);
      }

      const baseGroupId =
        terminalGroup.id.trim().length > 0
          ? terminalGroup.id.trim()
          : `group-${nextTerminalIds[0] ?? normalizedTerminalIds[0] ?? ""}`;
      nextGroups.push({
        id: assignUniqueGroupId(baseGroupId),
        terminalIds: nextTerminalIds,
        ...(terminalGroup.splitDirection === "vertical"
          ? { splitDirection: "vertical" as const }
          : {}),
      });
    }

    for (const terminalId of normalizedTerminalIds) {
      if (assignedTerminalIds.has(terminalId)) continue;
      nextGroups.push({
        id: assignUniqueGroupId(`group-${terminalId}`),
        terminalIds: [terminalId],
      });
    }

    const terminalOrderIndex = new Map(
      normalizedTerminalIds.map((id, index) => [id, index] as const),
    );
    nextGroups.sort((left, right) => {
      const rank = (ids: readonly string[]) =>
        Math.min(...ids.map((id) => terminalOrderIndex.get(id) ?? Number.POSITIVE_INFINITY));
      return rank(left.terminalIds) - rank(right.terminalIds);
    });

    return nextGroups;
  }, [normalizedTerminalIds, terminalGroups]);

  const resolvedActiveGroupIndex = useMemo(() => {
    const indexById = resolvedTerminalGroups.findIndex(
      (terminalGroup) => terminalGroup.id === activeTerminalGroupId,
    );
    if (indexById >= 0) return indexById;
    const indexByTerminal = resolvedTerminalGroups.findIndex((terminalGroup) =>
      terminalGroup.terminalIds.includes(resolvedActiveTerminalId),
    );
    return indexByTerminal >= 0 ? indexByTerminal : 0;
  }, [activeTerminalGroupId, resolvedActiveTerminalId, resolvedTerminalGroups]);

  const visibleTerminalIds =
    resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ??
    (normalizedTerminalIds.length > 0 ? [resolvedActiveTerminalId] : []);
  const splitDirection =
    resolvedTerminalGroups[resolvedActiveGroupIndex]?.splitDirection ?? "horizontal";
  const hasTerminalSidebar = normalizedTerminalIds.length > 1;
  const isSplitView = visibleTerminalIds.length > 1;
  const showGroupHeaders =
    resolvedTerminalGroups.length > 1 ||
    resolvedTerminalGroups.some((terminalGroup) => terminalGroup.terminalIds.length > 1);
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const terminalLabelById = useMemo(() => {
    const next = new Map<string, string>();
    for (const terminalId of normalizedTerminalIds) {
      next.set(terminalId, terminalLabelsById?.get(terminalId) ?? getTerminalLabel(terminalId));
    }
    return next;
  }, [normalizedTerminalIds, terminalLabelsById]);
  const resolveTerminalLaunchLocation = useCallback(
    (terminalId: string): TerminalLaunchLocation => {
      return (
        terminalLaunchLocationsById?.get(terminalId) ?? {
          cwd,
          ...(worktreePath !== undefined ? { worktreePath } : {}),
          ...(runtimeEnv ? { runtimeEnv } : {}),
        }
      );
    },
    [cwd, runtimeEnv, terminalLaunchLocationsById, worktreePath],
  );
  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal Horizontally (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitShortcutLabel
      ? `Split Terminal Horizontally (${splitShortcutLabel})`
      : "Split Terminal Horizontally";
  const splitTerminalVerticalActionLabel = hasReachedSplitLimit
    ? `Split Terminal Vertically (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitVerticalShortcutLabel
      ? `Split Terminal Vertically (${splitVerticalShortcutLabel})`
      : "Split Terminal Vertically";
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const closeTerminalActionLabel = closeShortcutLabel
    ? `Close Terminal (${closeShortcutLabel})`
    : "Close Terminal";
  const onSplitTerminalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminal();
  }, [hasReachedSplitLimit, onSplitTerminal]);
  const onSplitTerminalVerticalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminalVertical();
  }, [hasReachedSplitLimit, onSplitTerminalVertical]);
  const onNewTerminalAction = useCallback(() => {
    onNewTerminal();
  }, [onNewTerminal]);

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const syncHeight = useCallback((nextHeight: number) => {
    const clampedHeight = clampDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === clampedHeight) return;
    lastSyncedHeightRef.current = clampedHeight;
    onHeightChangeRef.current(clampedHeight);
  }, []);

  useEffect(() => {
    lastSyncedHeightRef.current = controlledDrawerHeight;
  }, [controlledDrawerHeight, threadId]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeDuringDragRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
    };
  }, []);

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      event.preventDefault();
      const clampedHeight = clampDrawerHeight(
        resizeState.startHeight + (resizeState.startY - event.clientY),
      );
      if (clampedHeight === drawerHeightRef.current) {
        return;
      }
      didResizeDuringDragRef.current = true;
      drawerHeightRef.current = clampedHeight;
      setDrawerHeight(clampedHeight);
    },
    [setDrawerHeight],
  );

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeDuringDragRef.current) {
        return;
      }
      syncHeight(drawerHeightRef.current);
      setResizeEpoch((value) => value + 1);
    },
    [syncHeight],
  );

  useEffect(() => {
    if (!visible) {
      return;
    }

    const onWindowResize = () => {
      const clampedHeight = clampDrawerHeight(drawerHeightRef.current);
      const changed = clampedHeight !== drawerHeightRef.current;
      if (changed) {
        setDrawerHeightFromWindowResize(clampedHeight);
        drawerHeightRef.current = clampedHeight;
      }
      if (!resizeStateRef.current) {
        syncHeight(clampedHeight);
      }
      setResizeEpoch((value) => value + 1);
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, [syncHeight, visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setResizeEpoch((value) => value + 1);
  }, [visible]);

  useEffect(() => {
    return () => {
      syncHeight(drawerHeightRef.current);
    };
  }, [syncHeight]);

  if (normalizedTerminalIds.length === 0) {
    return (
      <aside
        data-terminal-owner={isPanel ? "right-panel" : "drawer"}
        className={cn(
          "thread-terminal-drawer relative flex min-w-0 flex-col overflow-hidden bg-background",
          isPanel ? "h-full flex-1" : "shrink-0 border-t border-border/80",
        )}
        style={isPanel ? undefined : { height: `${drawerHeight}px` }}
      >
        {!isPanel ? (
          <div
            className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerEnd}
            onPointerCancel={handleResizePointerEnd}
          />
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-6 text-center text-sm text-muted-foreground">
          <p>No terminal sessions for this thread yet.</p>
          <button
            type="button"
            className="rounded-md border border-border/80 bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
            onClick={onNewTerminalAction}
          >
            {newTerminalActionLabel}
          </button>
        </div>
      </aside>
    );
  }

  const activeTerminalLaunchLocation = resolveTerminalLaunchLocation(resolvedActiveTerminalId);

  return (
    <aside
      ref={drawerElementRef}
      data-terminal-owner={isPanel ? "right-panel" : "drawer"}
      className={cn(
        "thread-terminal-drawer relative flex min-w-0 flex-col overflow-hidden bg-background",
        isPanel ? "h-full flex-1" : "shrink-0 border-t border-border/80",
      )}
      style={isPanel ? undefined : { height: `${drawerHeight}px` }}
    >
      {!isPanel ? (
        <div
          className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerEnd}
          onPointerCancel={handleResizePointerEnd}
        />
      ) : null}

      {!hasTerminalSidebar && (
        <div className="pointer-events-none absolute right-2 top-2 z-20">
          <div className="pointer-events-auto inline-flex items-center overflow-hidden rounded-md border border-border/80 bg-background/70">
            <TerminalActionButton
              className={`p-1 text-foreground/90 transition-colors ${
                hasReachedSplitLimit
                  ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                  : "hover:bg-accent"
              }`}
              onClick={onSplitTerminalAction}
              label={splitTerminalActionLabel}
            >
              <SquareSplitHorizontal className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className={`p-1 text-foreground/90 transition-colors ${
                hasReachedSplitLimit
                  ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                  : "hover:bg-accent"
              }`}
              onClick={onSplitTerminalVerticalAction}
              label={splitTerminalVerticalActionLabel}
            >
              <SquareSplitVertical className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={onNewTerminalAction}
              label={newTerminalActionLabel}
            >
              <Plus className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
              label={closeTerminalActionLabel}
            >
              <Trash2 className="size-3.25" />
            </TerminalActionButton>
          </div>
        </div>
      )}

      <div className="min-h-0 w-full flex-1">
        <div className={`flex h-full min-h-0 ${hasTerminalSidebar ? "gap-1.5" : ""}`}>
          <div className="min-w-0 flex-1">
            {isSplitView ? (
              <div
                className="grid h-full w-full min-w-0 gap-0 overflow-hidden"
                style={
                  splitDirection === "vertical"
                    ? {
                        gridTemplateRows: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
                      }
                    : {
                        gridTemplateColumns: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
                      }
                }
              >
                {visibleTerminalIds.map((terminalId) => {
                  const terminalLaunchLocation = resolveTerminalLaunchLocation(terminalId);
                  return (
                    <div
                      key={terminalId}
                      className={`min-h-0 min-w-0 ${
                        splitDirection === "vertical"
                          ? "border-t first:border-t-0"
                          : "border-l first:border-l-0"
                      } ${
                        terminalId === resolvedActiveTerminalId
                          ? "border-border"
                          : "border-border/70"
                      }`}
                      onMouseDown={() => {
                        if (terminalId !== resolvedActiveTerminalId) {
                          onActiveTerminalChange(terminalId);
                        }
                      }}
                    >
                      <div className="h-full p-1">
                        <TerminalViewport
                          threadRef={threadRef}
                          threadId={threadId}
                          terminalId={terminalId}
                          terminalLabel={terminalLabelById.get(terminalId) ?? "Terminal"}
                          cwd={terminalLaunchLocation.cwd}
                          {...(terminalLaunchLocation.worktreePath !== undefined
                            ? { worktreePath: terminalLaunchLocation.worktreePath }
                            : {})}
                          {...(terminalLaunchLocation.runtimeEnv
                            ? { runtimeEnv: terminalLaunchLocation.runtimeEnv }
                            : {})}
                          onSessionExited={() => onCloseTerminal(terminalId)}
                          onAddTerminalContext={onAddTerminalContext}
                          focusRequestId={focusRequestId}
                          autoFocus={terminalId === resolvedActiveTerminalId}
                          resizeEpoch={resizeEpoch}
                          drawerHeight={drawerHeight}
                          keybindings={keybindings}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="h-full p-1">
                <TerminalViewport
                  key={resolvedActiveTerminalId}
                  threadRef={threadRef}
                  threadId={threadId}
                  terminalId={resolvedActiveTerminalId}
                  terminalLabel={terminalLabelById.get(resolvedActiveTerminalId) ?? "Terminal"}
                  cwd={activeTerminalLaunchLocation.cwd}
                  {...(activeTerminalLaunchLocation.worktreePath !== undefined
                    ? { worktreePath: activeTerminalLaunchLocation.worktreePath }
                    : {})}
                  {...(activeTerminalLaunchLocation.runtimeEnv
                    ? { runtimeEnv: activeTerminalLaunchLocation.runtimeEnv }
                    : {})}
                  onSessionExited={() => onCloseTerminal(resolvedActiveTerminalId)}
                  onAddTerminalContext={onAddTerminalContext}
                  focusRequestId={focusRequestId}
                  autoFocus
                  resizeEpoch={resizeEpoch}
                  drawerHeight={drawerHeight}
                  keybindings={keybindings}
                />
              </div>
            )}
          </div>

          {hasTerminalSidebar && (
            <aside className="flex w-36 min-w-36 flex-col border-l border-border/60">
              <div className="flex h-[22px] items-stretch justify-end border-b border-border/70">
                <div className="inline-flex h-full items-stretch">
                  <TerminalActionButton
                    className={`inline-flex h-full items-center px-1 text-foreground/90 transition-colors ${
                      hasReachedSplitLimit
                        ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                        : "hover:bg-accent/70"
                    }`}
                    onClick={onSplitTerminalAction}
                    label={splitTerminalActionLabel}
                  >
                    <SquareSplitHorizontal className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className={`inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors ${
                      hasReachedSplitLimit
                        ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                        : "hover:bg-accent/70"
                    }`}
                    onClick={onSplitTerminalVerticalAction}
                    label={splitTerminalVerticalActionLabel}
                  >
                    <SquareSplitVertical className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                    onClick={onNewTerminalAction}
                    label={newTerminalActionLabel}
                  >
                    <Plus className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                    onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
                    label={closeTerminalActionLabel}
                  >
                    <Trash2 className="size-3.25" />
                  </TerminalActionButton>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
                {resolvedTerminalGroups.map((terminalGroup, groupIndex) => {
                  const isGroupActive =
                    terminalGroup.terminalIds.includes(resolvedActiveTerminalId);
                  const groupActiveTerminalId = isGroupActive
                    ? resolvedActiveTerminalId
                    : (terminalGroup.terminalIds[0] ?? resolvedActiveTerminalId);

                  return (
                    <div key={terminalGroup.id} className="pb-0.5">
                      {showGroupHeaders && (
                        <button
                          type="button"
                          className={`flex w-full items-center rounded px-1 py-0.5 text-[10px] uppercase tracking-[0.08em] ${
                            isGroupActive
                              ? "bg-accent/70 text-foreground"
                              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                          }`}
                          onClick={() => onActiveTerminalChange(groupActiveTerminalId)}
                        >
                          Group {groupIndex + 1}
                        </button>
                      )}

                      <div
                        className={showGroupHeaders ? "ml-1 border-l border-border/60 pl-1.5" : ""}
                      >
                        {terminalGroup.terminalIds.map((terminalId) => {
                          const isActive = terminalId === resolvedActiveTerminalId;
                          const closeTerminalLabel = `Close ${
                            terminalLabelById.get(terminalId) ?? "terminal"
                          }${isActive && closeShortcutLabel ? ` (${closeShortcutLabel})` : ""}`;
                          return (
                            <div
                              key={terminalId}
                              className={`group flex items-center gap-1 rounded px-1 py-0.5 text-[11px] ${
                                isActive
                                  ? "bg-accent text-foreground"
                                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                              } ${tearingTerminalId === terminalId ? "opacity-50" : ""}`}
                              onPointerDown={(event) => beginTearOff(event, terminalId)}
                              onPointerMove={moveTearOff}
                              onPointerUp={endTearOff}
                              onPointerCancel={endTearOff}
                              onClickCapture={suppressTearOffClick}
                            >
                              {showGroupHeaders && (
                                <span className="text-[10px] text-muted-foreground/80">└</span>
                              )}
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-1 text-left"
                                onClick={() => onActiveTerminalChange(terminalId)}
                              >
                                <TerminalSquare className="size-3 shrink-0" />
                                <span className="truncate">
                                  {terminalLabelById.get(terminalId) ?? "Terminal"}
                                </span>
                              </button>
                              {normalizedTerminalIds.length > 1 && (
                                <Popover>
                                  <PopoverTrigger
                                    openOnHover
                                    render={
                                      <button
                                        type="button"
                                        className="inline-flex size-3.5 items-center justify-center rounded text-xs font-medium leading-none text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
                                        onClick={() => onCloseTerminal(terminalId)}
                                        aria-label={closeTerminalLabel}
                                      />
                                    }
                                  >
                                    <XIcon className="size-2.5" />
                                  </PopoverTrigger>
                                  <PopoverPopup
                                    tooltipStyle
                                    side="bottom"
                                    sideOffset={6}
                                    align="center"
                                    className="pointer-events-none select-none"
                                  >
                                    {closeTerminalLabel}
                                  </PopoverPopup>
                                </Popover>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </aside>
          )}
        </div>
      </div>
    </aside>
  );
}
