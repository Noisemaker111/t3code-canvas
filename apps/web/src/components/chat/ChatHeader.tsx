import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, ArrowLeftIcon, BellIcon } from "lucide-react";
import { memo, useCallback, useState } from "react";
import GitActionsControl from "../GitActionsControl";
import { Button } from "../ui/button";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { stationKey } from "../canvas/panels/panelStations";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useKanbanCards, useKanbanCommands } from "../../state/kanban";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useHermesPing } from "../../lib/hermesPing";
import { toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

/**
 * Ask Hermes where this thread's card stands. Only a thread that has a card can
 * be asked about: the card id is what ties the answer to it, and Hermes's reply
 * lands in the board's Hermes panel.
 */
function PingHermesButton({ threadId }: { threadId: ThreadId }) {
  const { cards, hermes } = useKanbanCards();
  const { ping, pendingCardId } = useHermesPing();
  const card = cards.find((entry) => entry.threadId === threadId);
  if (!card) return null;
  const pinging = pendingCardId === card.id;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className={cn("no-drag shrink-0", pinging && "animate-pulse text-amber-500")}
            aria-label="Ping Hermes about this card"
            disabled={pinging}
            onClick={() =>
              void ping({
                cardId: card.id,
                title: card.title,
                hermesEnabled: hermes?.enabled === true,
              })
            }
          >
            <BellIcon className="size-4" />
          </Button>
        }
      />
      <TooltipPopup side="bottom">Ask Hermes what&apos;s up with this card</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Archive this conversation and, when it came from the board, its card too —
 * otherwise the card sits in Active pointing at an archived thread.
 */
function ArchiveThreadButton({
  environmentId,
  threadId,
  title,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  title: string;
}) {
  const { archiveThread } = useThreadActions();
  const { cards, environmentId: boardEnvironmentId, refresh } = useKanbanCards();
  const commands = useKanbanCommands(boardEnvironmentId);
  const [busy, setBusy] = useState(false);
  const card = cards.find((entry) => entry.threadId === threadId);

  const onArchive = useCallback(async () => {
    const ok = window.confirm(
      card
        ? `Archive "${title}" and its board card?\n\nBoth leave the board and Hermes stops seeing them. Restore from Settings → Board.`
        : `Archive "${title}"?\n\nRestore it any time from Settings → Board.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      if (card) {
        const cardResult = await commands.updateCard({ id: card.id, archived: true });
        if (cardResult._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: "Could not archive the card",
            description: "The conversation was left open.",
          });
          return;
        }
        refresh();
      }
      const result = await archiveThread(scopeThreadRef(environmentId, threadId));
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not archive the conversation",
          description: "A running turn must finish first.",
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: card ? "Conversation and card archived" : "Conversation archived",
        description: "Settings → Board restores it.",
      });
    } finally {
      setBusy(false);
    }
  }, [archiveThread, card, commands, environmentId, refresh, threadId, title]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className="no-drag shrink-0"
            aria-label="Archive conversation"
            disabled={busy}
            onClick={() => void onArchive()}
          >
            <ArchiveIcon className="size-4" />
          </Button>
        }
      />
      <TooltipPopup side="bottom">
        {card ? "Archive conversation + card" : "Archive conversation"}
      </TooltipPopup>
    </Tooltip>
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  // Back is out, not in: it leaves the page you are on for the canvas it sits
  // on, landing over that page. Going to the board instead put you inside a
  // region you were never in. A phone is the exception — the canvas at 390px is
  // a map of thumbnails, so there back is the board page it can actually read.
  const narrow = useIsMobile();
  const backOut = useCallback(() => {
    void navigate({
      to: "/kanban",
      search: narrow ? { station: stationKey({ kind: "column", entityId: "prompts" }) } : {},
    });
  }, [narrow, navigate]);
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                className="no-drag shrink-0"
                aria-label="Back"
                onClick={backOut}
              >
                <ArrowLeftIcon className="size-4" />
              </Button>
            }
          />
          <TooltipPopup side="bottom">Back</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
      </div>
      <div
        data-chat-header-actions
        className={cn(
          "flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
          rightPanelOpen ? "pr-0" : "pr-16",
        )}
      >
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {showOpenInPicker && (
          <OpenInPicker
            environmentId={activeThreadEnvironmentId}
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        <PingHermesButton threadId={activeThreadId} />
        <ArchiveThreadButton
          environmentId={activeThreadEnvironmentId}
          threadId={activeThreadId}
          title={activeThreadTitle}
        />
        {activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
          />
        )}
      </div>
    </div>
  );
});
