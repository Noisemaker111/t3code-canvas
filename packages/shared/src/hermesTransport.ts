/**
 * Which transport a Hermes brain selection resolves to.
 *
 * Shared, not server-only: the picker that makes the selection has to give the
 * same answer the tick will, or the board offers a model that fails every tick
 * afterwards with a reason nobody reads. The claims come off the wire
 * (`HermesBrainStatus.transports`) — there is no second routing table here.
 *
 * @module hermesTransport
 */
import {
  DEFAULT_HERMES_BRAIN_MODEL,
  type HermesTier,
  type HermesTransportClaim,
} from "@t3tools/contracts";

/** Instance + model, the same selection shape projects and model roles store. */
export type HermesModelSelection = {
  readonly instanceId: string | null;
  readonly model: string | null;
};

export type HermesTransport =
  | { readonly tier: HermesTier; readonly model: string; readonly reason: null }
  | { readonly tier: null; readonly model: string; readonly reason: string };

/** What this box could be pointed at, as a sentence tail. */
export function hermesRunnableList(transports: ReadonlyArray<HermesTransportClaim>): string {
  const named = transports.flatMap((transport) =>
    transport.driver ? [`a ${transport.driver} instance`] : [],
  );
  const prefixed = transports.flatMap((transport) =>
    transport.modelPrefix ? [`a ${transport.modelPrefix}… model`] : [],
  );
  const all = [...named, ...prefixed];
  return all.length === 0
    ? "nothing — no Hermes transport is wired up on this box"
    : all.join(", ");
}

/**
 * Resolve a `{instanceId, model}` selection to the transport that can actually
 * run it, using only what the wired-up backends claim: the driver kind an
 * instance is configured with, or a model-slug prefix. A selection outside
 * those claims — or no selection at all — resolves to no transport with a
 * reason, which fails the tick instead of quietly routing the board brain
 * somewhere it was not pointed.
 */
export function resolveHermesTransport(input: {
  readonly selection?: HermesModelSelection | null;
  /** Instance id → driver kind, from `ServerSettings.providerInstances`. */
  readonly drivers?: Readonly<Record<string, string>> | null;
  readonly transports: ReadonlyArray<HermesTransportClaim>;
}): HermesTransport {
  const model = (input.selection?.model ?? "").trim() || DEFAULT_HERMES_BRAIN_MODEL;
  const instanceId = (input.selection?.instanceId ?? "").trim();
  if (!instanceId) {
    return {
      tier: null,
      model,
      reason:
        "no provider instance is picked for the board brain — pick one in Settings → Hermes " +
        `(${hermesRunnableList(input.transports)})`,
    };
  }

  const prefixed = input.transports.find(
    (transport) => transport.modelPrefix !== null && model.startsWith(transport.modelPrefix),
  );
  if (prefixed?.modelPrefix) {
    return { tier: prefixed.tier, model: model.slice(prefixed.modelPrefix.length), reason: null };
  }

  // Built-in instance ids are the driver kind (`defaultInstanceIdForDriver`),
  // so an unconfigured box still resolves without a providerInstances entry.
  const driver = input.drivers?.[instanceId] ?? instanceId;
  const matched = input.transports.find((transport) => transport.driver === driver);
  if (matched) return { tier: matched.tier, model, reason: null };
  return {
    tier: null,
    model,
    reason:
      `${instanceId} (${driver}) is not a transport Hermes can run — pick ` +
      hermesRunnableList(input.transports),
  };
}
