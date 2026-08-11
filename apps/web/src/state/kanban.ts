import type {
  EnvironmentId,
  HermesBoardStatus,
  KanbanAppendCardHistoryInput,
  KanbanBoardControlInput,
  KanbanCard,
  ComponentId,
  KanbanCreateCardInput,
  KanbanLaunchActiveInput,
  KanbanListCardHistoryInput,
  KanbanMergePrInput,
  KanbanOpenIssue,
  KanbanOpenPr,
  KanbanOpenPrInput,
  KanbanPrChecks,
  KanbanUpdateCardInput,
} from "@t3tools/contracts";
import { useMemo, useRef } from "react";

import { usePrimaryEnvironment } from "./environments";
import { stabilizeKanbanBoardSnapshot } from "./kanbanBoardSnapshot";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

const EMPTY_CARDS: ReadonlyArray<KanbanCard> = [];
const EMPTY_PR_CHECKS: ReadonlyArray<KanbanPrChecks> = [];

export interface KanbanBoardSnapshot {
  readonly environmentId: EnvironmentId | null;
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly prChecks: ReadonlyArray<KanbanPrChecks>;
  readonly hermes: HermesBoardStatus | null;
}

const EMPTY_SNAPSHOT: KanbanBoardSnapshot = {
  environmentId: null,
  cards: EMPTY_CARDS,
  prChecks: EMPTY_PR_CHECKS,
  hermes: null,
};

/**
 * Keep the last board while a same-environment query is refetching.
 *
 * The board polls itself every few seconds, and a refresh can put the query
 * back into its initial state while the RPC connection reconnects. Rendering
 * that gap blanks the columns and unmounts whatever card you had open — on the
 * canvas it also blanks the panel, which reads as the whole app flickering. A
 * successful empty result still wins; only "no answer yet" is bridged.
 */
export function reconcileKanbanBoard(
  previous: KanbanBoardSnapshot,
  environmentId: EnvironmentId | null,
  data: {
    readonly cards?: ReadonlyArray<KanbanCard>;
    readonly prChecks?: ReadonlyArray<KanbanPrChecks>;
    readonly hermes?: HermesBoardStatus | null;
  } | null,
): KanbanBoardSnapshot {
  if (data === null) {
    return previous.environmentId === environmentId
      ? previous
      : { ...EMPTY_SNAPSHOT, environmentId };
  }
  return {
    environmentId,
    cards: data.cards ?? EMPTY_CARDS,
    prChecks: data.prChecks ?? EMPTY_PR_CHECKS,
    hermes: data.hermes ?? null,
  };
}

/** Read the kanban cards for the primary environment. */
export function useKanbanCards() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.kanbanCards({ environmentId, input: {} }),
  );
  const lastBoard = useRef<KanbanBoardSnapshot>(EMPTY_SNAPSHOT);

  const board = useMemo(() => {
    const reconciled = reconcileKanbanBoard(lastBoard.current, environmentId, data ?? null);
    lastBoard.current = stabilizeKanbanBoardSnapshot(lastBoard.current, reconciled);
    return lastBoard.current;
  }, [data, environmentId]);

  // Live Hermes for the header chip (heartbeats / summaries). Board columns use
  // the stabilized `hermesBoard` so poll churn does not rebuild every tile.
  const hermesLive = data?.hermes ?? board.hermes;

  return {
    environmentId,
    cards: board.cards,
    /** Forge CI verdicts, one per card with a PR the board could read. */
    prChecks: board.prChecks,
    /** Live Hermes brain status for the header chip. */
    hermes: hermesLive,
    /** Board-stabilized Hermes (queue badges / poll gating). */
    hermesBoard: board.hermes,
    error,
    /** Only the true first load — background refreshes must not look pending. */
    isPending: isPending && data === null && board.cards.length === 0,
    refresh,
  };
}

const EMPTY_OPEN_PRS: ReadonlyArray<KanbanOpenPr> = [];

/**
 * Open pull requests on the named repos — the review panel's query.
 *
 * `repos` empty is every repo the board has a project for. A repo the board
 * does not have fails the call rather than answering with the rest, so the
 * panel can say the list is wrong instead of showing a short one.
 */
export function useOpenPrs(repos: ReadonlyArray<string>) {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const key = repos.join("\u0000");
  const input = useMemo(() => ({ repos: key.length === 0 ? [] : key.split("\u0000") }), [key]);
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.kanbanOpenPrs({ environmentId, input }),
  );
  return {
    prs: data?.prs ?? EMPTY_OPEN_PRS,
    error,
    isPending: isPending && data === null,
    refresh,
  };
}

const EMPTY_OPEN_ISSUES: ReadonlyArray<KanbanOpenIssue> = [];

/**
 * Open issues on the named repos — the issue panel's query. Same vocabulary as
 * `useOpenPrs`: empty `repos` is every repo the board has a project for, and a
 * repo the board does not have fails the call rather than answering short.
 */
export function useOpenIssues(repos: ReadonlyArray<string>) {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const key = repos.join("\u0000");
  const input = useMemo(() => ({ repos: key.length === 0 ? [] : key.split("\u0000") }), [key]);
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.kanbanOpenIssues({ environmentId, input }),
  );
  return {
    issues: data?.issues ?? EMPTY_OPEN_ISSUES,
    error,
    isPending: isPending && data === null,
    refresh,
  };
}

/**
 * Command callbacks bound to the primary environment. Each resolves to an
 * `AtomCommandResult` so callers can surface failures.
 */
export function useKanbanCommands(environmentId: EnvironmentId | null) {
  const createCard = useAtomCommand(serverEnvironment.kanbanCreateCard, { reportFailure: false });
  const updateCard = useAtomCommand(serverEnvironment.kanbanUpdateCard, { reportFailure: false });
  const deleteCard = useAtomCommand(serverEnvironment.kanbanDeleteCard, { reportFailure: false });
  const boardControl = useAtomCommand(serverEnvironment.kanbanBoardControl, {
    reportFailure: false,
  });
  const launchActive = useAtomCommand(serverEnvironment.kanbanLaunchActive, {
    reportFailure: false,
  });
  const openPr = useAtomCommand(serverEnvironment.kanbanOpenPr, { reportFailure: false });
  const mergePr = useAtomCommand(serverEnvironment.kanbanMergePr, { reportFailure: false });
  const listCardHistory = useAtomCommand(serverEnvironment.kanbanListCardHistory, {
    reportFailure: false,
  });
  const appendCardHistory = useAtomCommand(serverEnvironment.kanbanAppendCardHistory, {
    reportFailure: false,
  });

  return useMemo(
    () => ({
      createCard: (input: KanbanCreateCardInput) =>
        environmentId === null
          ? Promise.reject(new Error("No environment connected."))
          : createCard({ environmentId, input }),
      updateCard: (input: KanbanUpdateCardInput) =>
        environmentId === null
          ? Promise.reject(new Error("No environment connected."))
          : updateCard({ environmentId, input }),
      deleteCard: (id: KanbanCard["id"]) =>
        environmentId === null
          ? Promise.reject(new Error("No environment connected."))
          : deleteCard({ environmentId, input: { id } }),
      /** Board controller turn: ramble → structured multi-card actions. */
      boardControl: (input: KanbanBoardControlInput) =>
        environmentId === null
          ? Promise.reject(new Error("No environment connected."))
          : boardControl({ environmentId, input }),
      /** Server-owned launch: card → coding thread + first turn, no navigation. */
      launchActive: (input: KanbanLaunchActiveInput) =>
        environmentId === null
          ? Promise.reject(new Error("No environment connected."))
          : launchActive({ environmentId, input }),
      /** Commit + push the card's worktree and open its PR. */
      openPr: (input: KanbanOpenPrInput) =>
        environmentId === null
          ? Promise.reject(new Error("No environment connected."))
          : openPr({ environmentId, input }),
      /** Merge the card's PR. Fails on conflicts / refused merges. */
      mergePr: (input: KanbanMergePrInput) =>
        environmentId === null
          ? Promise.reject(new Error("No environment connected."))
          : mergePr({ environmentId, input }),
      listCardHistory: (input: KanbanListCardHistoryInput) =>
        environmentId === null
          ? Promise.reject(new Error("No environment connected."))
          : listCardHistory({ environmentId, input }),
      appendCardHistory: (input: KanbanAppendCardHistoryInput) =>
        environmentId === null
          ? Promise.reject(new Error("No environment connected."))
          : appendCardHistory({ environmentId, input }),
    }),
    [
      environmentId,
      createCard,
      updateCard,
      deleteCard,
      boardControl,
      launchActive,
      openPr,
      mergePr,
      listCardHistory,
      appendCardHistory,
    ],
  );
}

/** Group cards by column, sorted by position, for board rendering. */
export function groupCardsByColumn(
  cards: ReadonlyArray<KanbanCard>,
): Map<ComponentId, ReadonlyArray<KanbanCard>> {
  const byColumn = new Map<ComponentId, KanbanCard[]>();
  for (const card of cards) {
    const existing = byColumn.get(card.at);
    if (existing) {
      existing.push(card);
    } else {
      byColumn.set(card.at, [card]);
    }
  }
  for (const list of byColumn.values()) {
    list.sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return byColumn;
}
