import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  PROVIDER_CREDENTIALS,
  resolveProviderKey,
  USAGE_PROVIDER_IDS,
  type ProviderCredentialContext,
} from "../usage/UsageService.ts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    next[variable.name] = variable.value;
  }
  return next;
}

/**
 * Fill in each family's key env var from the shared credential table, so a key
 * pasted in Settings → Connections → API keys reaches the spawned CLI without
 * being retyped per provider instance.
 *
 * A value already in the environment always wins — an instance variable, or an
 * inherited one — and a blank inherited value counts as unset, which is how an
 * untouched `OPENROUTER_API_KEY=` in `/etc/t3j.env` reads.
 */
export const withResolvedProviderKeys = (
  env: NodeJS.ProcessEnv,
  overrides: Partial<ProviderCredentialContext> = {},
): Effect.Effect<NodeJS.ProcessEnv> =>
  Effect.promise(async () => {
    let next = env;
    for (const family of USAGE_PROVIDER_IDS) {
      const envVar = PROVIDER_CREDENTIALS[family].envVar;
      if (!envVar || next[envVar]?.trim()) continue;
      const key = await resolveProviderKey(family, { env, ...overrides });
      if (key) next = { ...next, [envVar]: key };
    }
    return next;
  });

/** The spawn environment for a provider instance: its own variables, then resolved keys. */
export const resolveProviderInstanceEnvironment = (
  environment: ProviderInstanceEnvironment | undefined,
  options: {
    readonly baseEnv?: NodeJS.ProcessEnv;
    readonly credentials?: Partial<ProviderCredentialContext>;
  } = {},
): Effect.Effect<NodeJS.ProcessEnv> =>
  withResolvedProviderKeys(
    mergeProviderInstanceEnvironment(environment, options.baseEnv),
    options.credentials,
  );
