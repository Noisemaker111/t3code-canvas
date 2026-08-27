import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { Loader2Icon } from "lucide-react";
import { useMemo } from "react";

import ChatView from "../../ChatView";
import { useThread } from "../../../state/entities";
import { usePrimaryEnvironment } from "../../../state/environments";

/**
 * One coding thread, live on the canvas.
 *
 * Zoomed out this is the ticker — whether the turn is running and what it is
 * called — so panning across the thread row reads the work off the board. Open
 * it and the same panel becomes the real chat view, transcript and composer.
 */
export function ThreadPanel({
  threadId,
  opened,
}: {
  readonly threadId: string;
  readonly opened: boolean;
}) {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const threadRef = useMemo(
    () => (environmentId === null ? null : scopeThreadRef(environmentId, ThreadId.make(threadId))),
    [environmentId, threadId],
  );
  const thread = useThread(threadRef);

  if (environmentId === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        Connect an environment to see this thread.
      </div>
    );
  }

  // A card can name a thread this environment has never heard of — an archived
  // one, or a board restored against a different server. ChatView assumes its
  // thread exists, so the panel says so instead of mounting a broken view.
  if (opened && thread !== null) {
    return (
      <ChatView
        environmentId={environmentId}
        threadId={ThreadId.make(threadId)}
        routeKind="server"
      />
    );
  }

  const turn = thread?.latestTurn ?? null;
  const running = turn !== null && turn.completedAt === null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
      <p className="text-sm font-medium text-foreground">{thread?.title ?? "Thread"}</p>
      <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        {running ? <Loader2Icon className="size-3 animate-spin" /> : null}
        {thread === null
          ? "This environment has no such thread."
          : turn === null
            ? "No turn yet"
            : running
              ? `Running · ${turn.state}`
              : `Idle · ${turn.state}`}
      </p>
      {thread?.branch ? (
        <p className="truncate font-mono text-[11px] text-muted-foreground/80">{thread.branch}</p>
      ) : null}
      {thread === null ? null : (
        <p className="mt-auto text-[11px] text-muted-foreground/70">
          Zoom in to open the transcript.
        </p>
      )}
    </div>
  );
}
