import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useRef } from "react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { reconcileStickyData, type StickyData } from "./stickyData";

const EMPTY_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web-environment-query:empty"),
);

export interface EnvironmentQueryView<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

/** Human-readable message for a failed environment query or command cause. */
export function formatCauseMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    const record = error as { message?: unknown; _tag?: unknown };
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      return record.message;
    }
    if (typeof record._tag === "string" && record._tag.trim().length > 0) {
      return record._tag;
    }
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return "The environment request failed.";
}

export function useEnvironmentQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): EnvironmentQueryView<A> {
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
  const result = useAtomValue(selectedAtom);
  const refresh = useAtomRefresh(selectedAtom);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: result._tag === "Failure" ? formatCauseMessage(result.cause) : null,
    isPending: atom !== null && result.waiting,
    refresh,
  };
}

/**
 * Bridge an environment query's payload across reconnect refetch gaps, so a
 * panel bound to it does not blank every time a keepalive tick resets the query
 * to its initial state. See {@link reconcileStickyData}.
 */
export function useStickyEnvironmentData<A>(
  environmentId: EnvironmentId | null,
  data: A | null,
): A | null {
  const last = useRef<StickyData<A>>({ environmentId: null, data: null });
  return useMemo(() => {
    last.current = reconcileStickyData(last.current, environmentId, data);
    return last.current.data;
  }, [environmentId, data]);
}
