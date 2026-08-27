/**
 * btwPanelStore — UI state for the "/btw" side-chat panel.
 *
 * The panel is its OWN conversation, scoped per thread. Messages are
 * server-authoritative (persisted in `btw_messages`) and re-loaded on open, so
 * only the panel's open/closed flag is persisted here. Everything else — the
 * loaded messages and the in-flight streaming reply — lives in memory.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export interface BtwMessageView {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly streaming?: boolean;
}

interface BtwThreadData {
  readonly messages: ReadonlyArray<BtwMessageView>;
  readonly loaded: boolean;
  readonly sending: boolean;
  readonly error: string | null;
}

const EMPTY_DATA: BtwThreadData = { messages: [], loaded: false, sending: false, error: null };

interface BtwPanelStoreState {
  openByThreadKey: Record<string, boolean>;
  dataByThreadKey: Record<string, BtwThreadData>;
  open: (ref: ScopedThreadRef) => void;
  close: (ref: ScopedThreadRef) => void;
  toggle: (ref: ScopedThreadRef) => void;
  setLoadedMessages: (ref: ScopedThreadRef, messages: ReadonlyArray<BtwMessageView>) => void;
  appendUser: (ref: ScopedThreadRef, content: string) => void;
  beginAssistant: (ref: ScopedThreadRef) => void;
  appendAssistantDelta: (ref: ScopedThreadRef, text: string) => void;
  finishAssistant: (ref: ScopedThreadRef, content: string) => void;
  setSending: (ref: ScopedThreadRef, sending: boolean) => void;
  setError: (ref: ScopedThreadRef, error: string | null) => void;
  clearLocal: (ref: ScopedThreadRef) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

function dataFor(state: BtwPanelStoreState, key: string): BtwThreadData {
  return state.dataByThreadKey[key] ?? EMPTY_DATA;
}

function updateData(
  state: BtwPanelStoreState,
  ref: ScopedThreadRef,
  update: (current: BtwThreadData) => BtwThreadData,
): Pick<BtwPanelStoreState, "dataByThreadKey"> {
  const key = scopedThreadKey(ref);
  return {
    dataByThreadKey: {
      ...state.dataByThreadKey,
      [key]: update(dataFor(state, key)),
    },
  };
}

export const useBtwPanelStore = create<BtwPanelStoreState>()(
  persist(
    (set) => ({
      openByThreadKey: {},
      dataByThreadKey: {},
      open: (ref) =>
        set((state) => ({
          openByThreadKey: { ...state.openByThreadKey, [scopedThreadKey(ref)]: true },
        })),
      close: (ref) =>
        set((state) => ({
          openByThreadKey: { ...state.openByThreadKey, [scopedThreadKey(ref)]: false },
        })),
      toggle: (ref) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          return {
            openByThreadKey: { ...state.openByThreadKey, [key]: !state.openByThreadKey[key] },
          };
        }),
      setLoadedMessages: (ref, messages) =>
        set((state) =>
          updateData(state, ref, (current) => ({
            ...current,
            messages: messages.map((message) => ({ ...message })),
            loaded: true,
            error: null,
          })),
        ),
      appendUser: (ref, content) =>
        set((state) =>
          updateData(state, ref, (current) => ({
            ...current,
            messages: [...current.messages, { role: "user", content }],
            error: null,
          })),
        ),
      beginAssistant: (ref) =>
        set((state) =>
          updateData(state, ref, (current) => ({
            ...current,
            messages: [...current.messages, { role: "assistant", content: "", streaming: true }],
          })),
        ),
      appendAssistantDelta: (ref, text) =>
        set((state) =>
          updateData(state, ref, (current) => {
            const messages = current.messages.slice();
            const last = messages[messages.length - 1];
            if (last && last.role === "assistant" && last.streaming) {
              messages[messages.length - 1] = { ...last, content: last.content + text };
            } else {
              messages.push({ role: "assistant", content: text, streaming: true });
            }
            return { ...current, messages };
          }),
        ),
      finishAssistant: (ref, content) =>
        set((state) =>
          updateData(state, ref, (current) => {
            const messages = current.messages.slice();
            const last = messages[messages.length - 1];
            if (last && last.role === "assistant" && last.streaming) {
              messages[messages.length - 1] = { role: "assistant", content };
            } else {
              messages.push({ role: "assistant", content });
            }
            return { ...current, messages, sending: false };
          }),
        ),
      setSending: (ref, sending) =>
        set((state) => updateData(state, ref, (current) => ({ ...current, sending }))),
      setError: (ref, error) =>
        set((state) =>
          updateData(state, ref, (current) => ({ ...current, sending: false, error })),
        ),
      clearLocal: (ref) =>
        set((state) =>
          updateData(state, ref, () => ({
            messages: [],
            loaded: true,
            sending: false,
            error: null,
          })),
        ),
      removeThread: (ref) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          const { [key]: _open, ...openByThreadKey } = state.openByThreadKey;
          const { [key]: _data, ...dataByThreadKey } = state.dataByThreadKey;
          return { openByThreadKey, dataByThreadKey };
        }),
    }),
    {
      name: "t3code:btw-panel-state:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      // Only the open/closed flag is persisted; messages are reloaded from the
      // server so /btw reopens with its prior history after a reload.
      partialize: (state) => ({ openByThreadKey: state.openByThreadKey }),
    },
  ),
);

export function selectBtwPanelOpen(
  openByThreadKey: Record<string, boolean>,
  ref: ScopedThreadRef | null | undefined,
): boolean {
  if (!ref) return false;
  return openByThreadKey[scopedThreadKey(ref)] ?? false;
}

export function selectBtwThreadData(
  dataByThreadKey: Record<string, BtwThreadData>,
  ref: ScopedThreadRef | null | undefined,
): BtwThreadData {
  if (!ref) return EMPTY_DATA;
  return dataByThreadKey[scopedThreadKey(ref)] ?? EMPTY_DATA;
}
