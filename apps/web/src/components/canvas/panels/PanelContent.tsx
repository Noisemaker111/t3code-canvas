import { useEffect, useRef, useState, type ReactNode } from "react";

import { BoardPanel } from "./BoardPanel";
import { BrowserPanel } from "./BrowserPanel";
import { ColumnPanel } from "./ColumnPanel";
import { ComposerPanel } from "./ComposerPanel";
import { HermesPanel } from "./HermesPanel";
import { PanelPlaceholder } from "./PanelChrome";
import { PerfProbe } from "~/lib/perf/PerfProbe";
import type { PanelKind } from "./panelRegistry";
import { IssueListPanel } from "./IssueListPanel";
import { PanelSummaryView } from "./PanelSummary";
import { panelLabel } from "./panelLabels";
import { PrReviewPanel } from "./PrReviewPanel";
import { panelHeavyBodyOpen, type PanelTier } from "./panelTiers";
import { SettingsPanel } from "./SettingsPanel";
import { TerminalPanel } from "./TerminalPanel";
import { ThreadListPanel } from "./ThreadListPanel";
import { ThreadPanel } from "./ThreadPanel";
import { GitPanel } from "./GitPanel";
import { EditorPanel, ExplorerPanel } from "./WorkspacePanels";

/**
 * The render half of the panel registry.
 *
 * Kept apart from `panelRegistry` — which holds everything about a kind that is
 * not pixels — because that module is read by the tldraw shape schema and by
 * node tests, and importing a transcript view into either is how a unit test
 * ends up booting a diff worker.
 *
 * @module components/canvas/panels/PanelContent
 */

interface PanelBodyProps {
  readonly entityId: string;
  /**
   * Whether the body should open its heavy surface (transcript, xterm, …).
   * Latched for most kinds; terminals and browsers only at the live tier.
   */
  readonly opened: boolean;
  /** Serialized knob edits this panel is holding. Dev panels only. */
  readonly overrides: string;
  readonly onOverridesChange: (next: string) => void;
}

const PANEL_BODIES: Record<PanelKind, (props: PanelBodyProps) => ReactNode> = {
  // The columns, the composer and Hermes are what the canvas is for: they stay
  // mounted so panning past them shows the real queue and the real conversation.
  column: ({ entityId }) => <ColumnPanel entityId={entityId} />,
  composer: () => <ComposerPanel />,
  // A board panel only survives from a pre-split snapshot until it is reaped.
  board: () => <BoardPanel />,
  hermes: () => <HermesPanel />,
  settings: ({ opened }) => <SettingsPanel opened={opened} />,
  thread: ({ entityId, opened }) => <ThreadPanel threadId={entityId} opened={opened} />,
  threads: ({ entityId }) => <ThreadListPanel entityId={entityId} />,
  // The gallery is gone. A leftover shape draws nothing for the one pass
  // between the snapshot loading and the reconciler reaping it.
  dev: () => null,
  terminal: ({ entityId, opened }) => <TerminalPanel entityId={entityId} opened={opened} />,
  browser: ({ entityId, opened }) => <BrowserPanel entityId={entityId} opened={opened} />,
  explorer: ({ entityId }) => <ExplorerPanel entityId={entityId} />,
  git: ({ entityId }) => <GitPanel entityId={entityId} />,
  editor: ({ entityId, opened }) => <EditorPanel entityId={entityId} opened={opened} />,
  prs: ({ entityId }) => <PrReviewPanel entityId={entityId} />,
  issues: ({ entityId }) => <IssueListPanel entityId={entityId} />,
};

/**
 * Latch a panel on the first time it is looked at.
 *
 * A canvas holds more pages than a screen does, and a transcript that has never
 * been opened does not need its editor, diff workers and terminals built. Once
 * built we keep it: coming back to a thread must not replay its boot.
 */
function useOpenedOnce(live: boolean): boolean {
  const [opened, setOpened] = useState(live);
  const openedRef = useRef(live);
  useEffect(() => {
    if (!live || openedRef.current) return;
    openedRef.current = true;
    setOpened(true);
  }, [live]);
  return opened || live;
}

export function PanelContent({
  kind,
  entityId,
  live,
  tier,
  overrides,
  onOverridesChange,
}: {
  readonly kind: PanelKind;
  readonly entityId: string;
  readonly live: boolean;
  /** How much of this panel to draw at the size it is on screen. */
  readonly tier: PanelTier;
  /** Serialized knob edits this panel is holding. Dev panels only. */
  readonly overrides: string;
  readonly onOverridesChange: (next: string) => void;
}) {
  // Drawn for real counts as looked at: a big panel just off screen renders at
  // the live tier with `live` still false, and without the latch its body would
  // be dropped again the moment the zoom crossed back down.
  const kept = useOpenedOnce(live || tier === "live");
  const live_ = tier === "live";
  // Terminals and browsers remount from the session; keep their xterm / guest
  // off when the tier is not live so a stationed page is not fighting a second
  // shell still attached behind it.
  const opened = kept && panelHeavyBodyOpen(kind, tier);

  // A panel that has never been looked at does not build its body at all — that
  // is the whole saving, and on a zoomed-out canvas it is most of them. One that
  // has stays mounted behind the summary: a transcript rebuilt every time you
  // zoomed out past it and back would make the zoom a way to lose work.
  const body = kept
    ? (PANEL_BODIES[kind]?.({ entityId, opened, overrides, onOverridesChange }) ?? null)
    : null;

  // The body keeps the same slot in the tree at every tier — `contents` when it
  // is the panel, `hidden` when a summary is drawn over it. Returning it bare at
  // the live tier and wrapped below it used to be a different position in the
  // element tree, so React tore the whole page down and rebuilt it on each
  // crossing: one zoom out and back rebuilt every transcript, terminal and diff
  // worker on screen. Same slot, same instance, one class flip.
  return (
    <>
      {live_ ? null : tier === "summary" ? (
        <PanelSummaryView kind={kind} entityId={entityId} label={panelLabel(kind, entityId)} />
      ) : (
        <PanelPlaceholder />
      )}
      <div className={live_ ? "contents" : "hidden"}>
        {body === null ? null : <PerfProbe target={`${kind}:${entityId}`}>{body}</PerfProbe>}
      </div>
    </>
  );
}
