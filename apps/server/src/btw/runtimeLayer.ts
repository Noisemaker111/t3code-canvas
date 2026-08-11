import * as Layer from "effect/Layer";

import { BtwMessageRepositoryLive } from "../persistence/Layers/BtwMessages.ts";
import { ConversationLogRepositoryLive } from "../persistence/Layers/ConversationLog.ts";
import { BtwChatServiceLive } from "./BtwChatService.ts";

/**
 * Aggregated btw side-chat services: message persistence, the read-only
 * conversation_log query, and the streaming chat model.
 *
 * Requirements (`SqlClient` for the repositories, `ChildProcessSpawner`/`Path`
 * for the chat service) are satisfied by the surrounding runtime layer stack.
 */
export const BtwLayerLive = Layer.mergeAll(
  BtwMessageRepositoryLive,
  ConversationLogRepositoryLive,
  BtwChatServiceLive,
);
