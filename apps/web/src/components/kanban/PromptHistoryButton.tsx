import { ClockIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  notifyPromptHistoryReuse,
  readStoredPromptHistory,
  subscribePromptHistory,
} from "../../lib/promptHistory";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { cn } from "~/lib/utils";

/** Shared draft id for the board capture composer — history reuse writes here. */
export const KANBAN_COMPOSER_DRAFT_ID = DraftId.make("kanban-capture");

/**
 * Clock control for the Prompts column header: opens submitted-prompt history
 * and fills the board composer when an entry is chosen.
 */
export function PromptHistoryButton({ className }: { readonly className?: string }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<readonly string[]>(() => readStoredPromptHistory());
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);

  useEffect(() => subscribePromptHistory(setHistory), []);

  const reuse = (entry: string) => {
    setPrompt(KANBAN_COMPOSER_DRAFT_ID, entry);
    notifyPromptHistoryReuse(entry);
    setOpen(false);
  };

  // Newest first in the menu.
  const entries = history.toReversed();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        title="Prompt history"
        aria-label="Prompt history"
        className={cn(
          "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          className,
        )}
      >
        <ClockIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="end"
        sideOffset={6}
        className="w-72 max-w-[min(18rem,calc(100vw-2rem))] p-0"
      >
        <div className="border-b border-border px-3 py-2">
          <p className="text-xs font-medium text-foreground">Prompt history</p>
          <p className="text-[11px] text-muted-foreground">
            Reuse a past capture. ↑ in an empty composer cycles these too.
          </p>
        </div>
        {entries.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">No submitted prompts yet.</p>
        ) : (
          <ul className="max-h-64 overflow-y-auto py-1" role="listbox" aria-label="Prompt history">
            {entries.map((entry) => (
              <li key={entry}>
                <button
                  type="button"
                  role="option"
                  className="flex w-full px-3 py-2 text-left text-xs leading-snug text-foreground hover:bg-accent"
                  onClick={() => reuse(entry)}
                >
                  <span className="line-clamp-3 whitespace-pre-wrap break-words">{entry}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverPopup>
    </Popover>
  );
}
