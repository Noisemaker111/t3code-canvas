import { useCallback, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { primaryServerProvidersAtom, serverEnvironment } from "../state/server";
import { usePrimaryEnvironment } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Re-probes every configured provider instance's local CLI/process — used
 * by both the Providers settings page (connection status) and the Models
 * settings page (model catalogs, since a provider like `opencode` reports
 * whatever models its own upstream — e.g. OpenRouter — currently exposes).
 */
export function useRefreshServerProviders() {
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshingRef = useRef(false);

  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  const refresh = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    if (!primaryEnvironment) {
      refreshingRef.current = false;
      setIsRefreshing(false);
      return;
    }
    void (async () => {
      const result = await refreshServerProviders({
        environmentId: primaryEnvironment.environmentId,
        input: {},
      });
      refreshingRef.current = false;
      setIsRefreshing(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        console.warn("Failed to refresh providers", {
          operation: "refresh-providers",
          environmentId: primaryEnvironment.environmentId,
          ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
        });
      }
    })();
  }, [primaryEnvironment, refreshServerProviders]);

  return { refresh, isRefreshing, lastCheckedAt };
}
