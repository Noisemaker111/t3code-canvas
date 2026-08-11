/**
 * Keeps Board prefs durable in server settings.json.
 * Mount once under AppRoot so every surface (board, settings) dual-writes.
 */
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../hooks/useSettings";
import {
  applyServerBoardSettings,
  bindBoardSettingsServerPersist,
  hydrateBoardSettingsFromServer,
} from "../lib/boardSettings";
import { primaryServerConfigAtom } from "../state/server";

export function BoardSettingsSync() {
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const serverBoard = usePrimarySettings((settings) => settings.boardSettings);
  const updateSettings = useUpdatePrimarySettings();
  const hydratedRef = useRef(false);

  useEffect(() => {
    bindBoardSettingsServerPersist((next) => {
      updateSettings({ boardSettings: next });
    });
    return () => bindBoardSettingsServerPersist(null);
  }, [updateSettings]);

  useEffect(() => {
    if (!serverConfig) return;
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    hydrateBoardSettingsFromServer(serverBoard);
  }, [serverBoard, serverConfig]);

  // When another client/tab patches boardSettings on the server, refresh the local cache.
  useEffect(() => {
    if (!hydratedRef.current) return;
    applyServerBoardSettings(serverBoard);
  }, [serverBoard]);

  return null;
}
