/**
 * The panel registry — one manifest per kind of page the canvas can hold.
 *
 * Everything about a kind that is not pixels lives here: what it is called, how
 * big it wants to be, how small it may be squashed, whether there is one of it
 * or one per thing, whether the canvas re-creates it when it goes missing, and
 * what closing it does to the resource behind it. `PanelContent` holds the
 * other half — the component each kind renders — because this module has to
 * stay importable from a node test and from the tldraw shape schema.
 *
 * Adding a kind is adding an entry to {@link PANEL_MANIFESTS} plus a renderer.
 * The switch statements this replaced meant a new kind compiled fine and then
 * fell through five different `default` branches at runtime.
 *
 * The manifest is deliberately open: per-kind policy hangs off it — the zoom
 * degrade ladder ({@link PanelSummary}) is here for the same reason — rather
 * than growing another `Record<PanelKind, …>` beside it.
 *
 * @module components/canvas/panels/panelRegistry
 */

import { parseThreadScopedEntityId } from "./panelThreadScope";

export const PANEL_KINDS = [
  /**
   * `board` stays in the union for two reasons: snapshots saved before the
   * board split into column panels contain a `board` shape the schema must
   * still read, and `?station=board` remains the address of the kanban — the
   * Board frame, once the wrap pass has built one.
   */
  "board",
  "column",
  "composer",
  "hermes",
  "thread",
  "threads",
  "settings",
  /**
   * `dev` was the component gallery. It is gone, and stays in the union for the
   * same reason `board` does: a snapshot saved while it existed holds `dev`
   * shapes the schema must still read so the canvas opens at all. Nothing
   * desires one, so the first reconcile pass reaps them.
   */
  "dev",
  "terminal",
  "browser",
  "explorer",
  "editor",
  "git",
  "prs",
  "issues",
] as const;
/**
 * What kind of thing a panel is. Any name — a component somebody writes has to
 * have somewhere to be, and a closed union is a list nobody outside this file
 * can add to.
 *
 * {@link PANEL_KINDS} stays as the kinds *this build* ships, which is what the
 * add menu offers and what the tests enumerate. It is not a schema: a snapshot
 * naming a kind this build does not have keeps it, and {@link panelManifest}
 * answers with a plain box rather than crashing the canvas.
 */
export type PanelKind = string;

/** One of the kinds this build ships. Use where the *shipped* kind is meant. */
export type BuiltinPanelKind = (typeof PANEL_KINDS)[number];

export interface PanelSize {
  readonly w: number;
  readonly h: number;
}

/**
 * What a kind shows when it is too small to render for real but too big to be a
 * bare box — the middle rung of the zoom ladder (`panelTiers`).
 *
 * Every kind states one, and every view here is cheap by construction: board
 * cards the columns already hold, a thread's shell metadata. Nothing on this
 * ladder may subscribe to a transcript or start a worker — a zoomed-out canvas
 * is twenty of these at once.
 *
 * `none` is an answer, not an omission: the kind has no smaller reading of
 * itself, so it draws the placeholder. A kind with no entry at all would render
 * its whole page behind every box on the canvas, which is the bug this replaces.
 */
export type PanelSummary =
  | { readonly view: "none"; readonly reason: string }
  /** Title plus one declared line. Reads nothing, so it costs nothing. */
  | { readonly view: "static"; readonly line: string }
  /** Column title, card count, one dot per card in the board's own tone. */
  | { readonly view: "column" }
  /** Thread title and the state of its latest turn, off the thread shell. */
  | { readonly view: "thread" }
  /** Open-PR count, one dot per pull request, owned or not. */
  | { readonly view: "prs" };

export interface PanelManifest {
  readonly kind: PanelKind;
  /** Title-bar name. Kinds with instances refine it from the entity id. */
  readonly label: string;
  /** Authored size — what a fresh panel of this kind is created at. */
  readonly size: PanelSize;
  /** Smallest a human may drag it to before the body stops being readable. */
  readonly minSize: PanelSize;
  /** One panel for the whole app, or one per entity id. */
  readonly instances: "singleton" | "instances";
  /**
   * Force-present: the reconciler re-creates it however it went away, and the
   * human cannot close it. The capture composer is home and never goes away;
   * the columns are not — a column is a component you add and remove.
   */
  readonly persistent: boolean;
  /**
   * Whether the reconciler may delete this panel when nothing points at it any
   * more. True only for panels that stand for something the board owns — a
   * thread's card, or the pre-split board panel. A panel a human opened is
   * theirs: it is never reaped, and never respawned once they close it.
   */
  readonly reapable: boolean;
  /** Offered by the command palette and the canvas "Add component" menu. */
  readonly addable: boolean;
  /**
   * Whether the panel fronts a live session on the server. Closing one detaches
   * — the pty, the turn and the transcript keep running without a window on
   * them (see {@link panelCloseAction}).
   */
  readonly ownsSession: boolean;
  /** Whether the panel reads a project's workspace root, via its entity id. */
  readonly workspaceScoped: boolean;
  /** What this kind degrades to on a zoomed-out canvas. Never defaulted. */
  readonly summary: PanelSummary;
}

type ManifestSeed = Omit<PanelManifest, "kind">;

const DEFAULTS: Omit<ManifestSeed, "label" | "size" | "summary"> = {
  minSize: { w: 360, h: 260 },
  instances: "singleton",
  persistent: false,
  reapable: false,
  addable: false,
  ownsSession: false,
  workspaceScoped: false,
};

function manifest(
  kind: PanelKind,
  seed: Partial<ManifestSeed> & Pick<ManifestSeed, "label" | "size" | "summary">,
): PanelManifest {
  return { kind, ...DEFAULTS, ...seed };
}

export const PANEL_MANIFESTS: Record<string, PanelManifest> = {
  board: manifest("board", {
    label: "Board",
    size: { w: 1480, h: 920 },
    reapable: true,
    summary: {
      view: "none",
      reason: "A pre-split snapshot's shape, reaped on the first reconcile pass.",
    },
  }),
  column: manifest("column", {
    label: "Column",
    size: { w: 350, h: 840 },
    // A card tile is one truncating title line: it survives being scaled down
    // far past what a transcript or a diff does, and the board frame parks its
    // four columns well under 1:1. Claiming 260 here turned the home screen
    // into four dots at any zoom below 0.72.
    minSize: { w: 190, h: 320 },
    instances: "instances",
    // A column *is* this panel: closing one removes the column, and Add
    // component puts another on the canvas. The reconciler still mints a panel
    // for any column the cards are sitting in, so closing one that holds work
    // brings it straight back rather than hiding the cards.
    addable: true,
    summary: { view: "column" },
  }),
  composer: manifest("composer", {
    // Sized to the composer form it holds, not the row above it.
    label: "Capture",
    size: { w: 820, h: 190 },
    // The capture bar and the columns are one region, and the board station
    // fits all of them at once — so a minimum stricter than the column's, read
    // as a fraction of the panel's own size, is a capture bar that goes blank
    // at the zoom its own station picks. 140 of 190 was 74%, twice the column's
    // 38%, and it cost the home screen its composer on every window under
    // 2560x1440. These are the column's fractions: what the region can render,
    // the capture bar renders with it.
    minSize: { w: 300, h: 72 },
    persistent: true,
    summary: {
      view: "none",
      reason: "The panel is one text field: a smaller reading of it is a fake text field.",
    },
  }),
  hermes: manifest("hermes", {
    label: "Hermes",
    size: { w: 560, h: 920 },
    minSize: { w: 360, h: 300 },
    addable: true,
    summary: { view: "static", line: "Routing the board." },
  }),
  thread: manifest("thread", {
    label: "Thread",
    size: { w: 900, h: 820 },
    minSize: { w: 400, h: 320 },
    instances: "instances",
    reapable: true,
    ownsSession: true,
    summary: { view: "thread" },
  }),
  threads: manifest("threads", {
    label: "Threads",
    size: { w: 300, h: 760 },
    minSize: { w: 220, h: 240 },
    addable: true,
    summary: { view: "static", line: "Every active thread, one row each." },
  }),
  settings: manifest("settings", {
    label: "Settings",
    size: { w: 1080, h: 920 },
    minSize: { w: 420, h: 320 },
    addable: true,
    summary: { view: "static", line: "Providers, environments, updates." },
  }),
  dev: manifest("dev", {
    label: "Dev gallery",
    size: { w: 1180, h: 920 },
    instances: "instances",
    reapable: true,
    summary: {
      view: "none",
      reason: "A removed gallery's shape, reaped on the first reconcile pass.",
    },
  }),
  terminal: manifest("terminal", {
    label: "Terminal",
    size: { w: 820, h: 460 },
    minSize: { w: 320, h: 200 },
    // One panel per shell: the empty entity id is the host console with its
    // tab strip; `terminal:<terminalId>` is a window onto that one pty, which
    // is what duplicating a terminal pane or tearing a tab off produces; and
    // `terminal:<threadId>/<terminalId>` is a shell a thread is running.
    instances: "instances",
    addable: true,
    // Only the thread's shells are reaped, and the reconciler is what draws
    // that line: it keeps every host-console panel in its desired set, so what
    // is left to go stale is a pty that has exited under a thread.
    reapable: true,
    ownsSession: true,
    summary: { view: "static", line: "A shell on the box." },
  }),
  browser: manifest("browser", {
    label: "Browser",
    // Sized for a 1280×800 page plus the toolbar row, at a readable scale.
    size: { w: 880, h: 590 },
    minSize: { w: 360, h: 260 },
    // One panel per live tab (`browser:<threadId>/<tabId>`); the empty entity
    // id is the human's board browser from the add menu.
    instances: "instances",
    addable: true,
    // Auto-spawned tab panels vanish with their session; closing one detaches
    // the view and leaves the page running for the agent.
    reapable: true,
    ownsSession: true,
    summary: { view: "static", line: "A live page on the box." },
  }),
  explorer: manifest("explorer", {
    label: "Files",
    size: { w: 420, h: 760 },
    minSize: { w: 260, h: 260 },
    instances: "instances",
    addable: true,
    workspaceScoped: true,
    summary: { view: "static", line: "The project's file tree." },
  }),
  prs: manifest("prs", {
    label: "Pull requests",
    size: { w: 520, h: 760 },
    minSize: { w: 300, h: 260 },
    // One panel per repo binding: the address is the query (`prs:owner/repo`) —
    // what the forge is asked for. Narrowing the answer is the panel's toolbar.
    instances: "instances",
    addable: true,
    summary: { view: "prs" },
  }),
  issues: manifest("issues", {
    label: "Issues",
    size: { w: 520, h: 760 },
    minSize: { w: 300, h: 260 },
    // Same addressing as `prs`: the repo binding is the address, so two lists
    // over two repos are two panels rather than one that toggles.
    instances: "instances",
    addable: true,
    summary: { view: "static", line: "Open issues on the bound repos." },
  }),
  git: manifest("git", {
    label: "Git",
    size: { w: 380, h: 760 },
    minSize: { w: 300, h: 280 },
    // One panel per project workspace (`git:<projectId>`): two checkouts are
    // two working trees, and a panel that toggled between them would stage
    // files into whichever one it was last pointed at.
    instances: "instances",
    addable: true,
    workspaceScoped: true,
    summary: { view: "static", line: "Branch, changes, commit." },
  }),
  editor: manifest("editor", {
    label: "Editor",
    size: { w: 980, h: 760 },
    instances: "instances",
    workspaceScoped: true,
    // The panel's label is the file path, so the title line carries the name.
    summary: { view: "static", line: "Open file." },
  }),
};

/**
 * The manifest for a kind, or the one an unknown kind gets: a plain box the
 * canvas can draw, move and close. A snapshot written by a build that had a
 * kind this one does not must not take the page down with it.
 */
export function panelManifest(kind: PanelKind): PanelManifest {
  return PANEL_MANIFESTS[kind] ?? UNKNOWN_PANEL;
}

const UNKNOWN_PANEL: PanelManifest = manifest("unknown", {
  label: "Unknown panel",
  size: { w: 480, h: 320 },
  minSize: { w: 240, h: 160 },
  instances: "instances",
  summary: { view: "none", reason: "this build has no renderer for it" },
});

/**
 * Whether the reconciler may delete *this* panel — the manifest's rule, read
 * against the panel's own address.
 *
 * A terminal or a browser is two things under one kind: a panel a human opened
 * from the add menu, which is theirs forever, and a panel the canvas minted for
 * a shell or a tab a thread is running, which goes when that session does. The
 * address is what tells them apart ({@link parseThreadScopedEntityId}), so the
 * question cannot be answered by kind alone.
 */
export function panelReapable(ref: {
  readonly kind: PanelKind;
  readonly entityId: string;
}): boolean {
  if (!panelManifest(ref.kind).reapable) return false;
  if (ref.kind === "terminal" || ref.kind === "browser")
    return parseThreadScopedEntityId(ref.entityId) !== null;
  return true;
}

/** A collapsed panel is its title bar and nothing else. */
export const PANEL_TITLE_BAR_HEIGHT = 32;

/** Authored sizes, by kind. Where a fresh panel of each kind starts. */
export const PANEL_SIZE: Record<string, PanelSize> = Object.fromEntries(
  PANEL_KINDS.map((kind) => [kind, panelManifest(kind).size]),
) as Record<string, PanelSize>;

/**
 * The kinds a human can put back on the canvas after closing one — the command
 * palette's list and the canvas "Add component" menu, in one order.
 */
export const ADDABLE_PANEL_KINDS: ReadonlyArray<PanelKind> = PANEL_KINDS.filter(
  (kind) => panelManifest(kind).addable,
);

/** Whether the human may close this panel at all. Home is never closable. */
export function isPanelClosable(kind: PanelKind): boolean {
  return !panelManifest(kind).persistent;
}

/**
 * What closing a panel does to what is behind it.
 *
 * `detach` is the whole point of the distinction: a terminal panel is a window
 * onto the host console's pty and a thread panel is a window onto a running
 * turn. Closing the window must never be how a human kills either — the same
 * session is still there from the dock, or from the card on the board.
 */
export function panelCloseAction(kind: PanelKind): "detach" | "discard" {
  return panelManifest(kind).ownsSession ? "detach" : "discard";
}

/** The authored size for a kind, or the unknown panel's. Never undefined. */
export function panelSize(kind: PanelKind): PanelSize {
  return PANEL_SIZE[kind] ?? panelManifest(kind).size;
}
