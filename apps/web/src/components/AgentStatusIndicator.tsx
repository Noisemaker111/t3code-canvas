import { BotIcon } from "lucide-react";

import type { AgentStatusLevel } from "../session-logic";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Global agent health light, pinned bottom-right just above the version badge.
 *
 * Rather than plastering the conversation with repeated "rate-limited, please
 * retry" errors, transient provider trouble collapses down to this one robot:
 * it pulses amber while a provider is rate-limited and the run keeps retrying,
 * and glows red when the agent genuinely can't make progress. When everything
 * is healthy it renders nothing, staying out of the way.
 */
export function AgentStatusIndicator({
  level,
  message,
}: {
  level: AgentStatusLevel;
  message?: string | null;
}) {
  if (level === "idle") {
    return null;
  }

  const isError = level === "error";
  const detail = message?.trim() ? message.trim() : null;
  const headline = isError
    ? "Agent can't reach the model — still retrying"
    : "Provider rate-limited — holding on and retrying";
  const tooltip = detail ? `${headline}\n${detail}` : headline;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            role="status"
            aria-label={tooltip}
            className={cn(
              "agent-status-indicator",
              isError ? "agent-status-indicator--error" : "agent-status-indicator--retrying",
            )}
          />
        }
      >
        <BotIcon className="size-4" aria-hidden strokeWidth={2.25} />
      </TooltipTrigger>
      <TooltipPopup side="left" className="max-w-64 whitespace-pre-line text-[11px]">
        {tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}
