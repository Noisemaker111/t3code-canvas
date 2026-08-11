/**
 * One-time migration off the legacy Hermes fallback chain.
 *
 * The chain is gone: an unresolvable selection now fails the tick. A board
 * saved before the brain had a `{instanceId, model}` selection carries a null
 * instance, so the head of its old chain is written to disk once, on boot. It
 * is a persisted rewrite, not a read-time default — after it runs, the file
 * says which provider the brain is on.
 *
 * @module kanban/hermes/legacySelectionMigration
 */
import {
  DEFAULT_HERMES_BRAIN_INSTANCE_ID,
  HERMES_TIERS,
  type HermesTier,
} from "@t3tools/contracts";

import type { HermesTransportClaim } from "./backend.ts";

/**
 * The owner reordered or disabled tiers, so the head is a choice worth keeping.
 *
 * Only the relative order of the tiers the board actually stored counts: a
 * chain written before `codex` existed is short, not customised, and reading it
 * as a choice would pin those boards to the wrong default forever.
 */
function customisedChain(input: {
  readonly order: ReadonlyArray<HermesTier>;
  readonly disabled: ReadonlyArray<HermesTier>;
  /** Tier the shipped default instance runs on. A chain without it is a choice. */
  readonly shippedTier: HermesTier;
}): boolean {
  if (input.disabled.length > 0) return true;
  const stored = input.order.filter((tier) => HERMES_TIERS.includes(tier));
  if (stored.length > 0 && !stored.includes(input.shippedTier)) return true;
  const canonical = HERMES_TIERS.filter((tier) => stored.includes(tier));
  return stored.some((tier, index) => tier !== canonical[index]);
}

export type HermesLegacySelectionPatch = {
  readonly hermesBrainInstanceId: string;
  /** Set only when the head transport claims a model prefix the slug lacks. */
  readonly hermesBrainModel?: string;
};

function legacyHead(input: {
  readonly order: ReadonlyArray<HermesTier>;
  readonly disabled: ReadonlyArray<HermesTier>;
}): HermesTier | null {
  const ordered = [...input.order, ...HERMES_TIERS.filter((tier) => !input.order.includes(tier))];
  const disabled = new Set(input.disabled);
  return ordered.find((tier) => !disabled.has(tier)) ?? null;
}

/**
 * The selection to persist for a board that never picked one, or null when
 * there is nothing to migrate — an already-picked board, or a chain head no
 * wired-up transport claims, which is left to fail with its own reason.
 */
export function hermesLegacySelectionPatch(input: {
  readonly instanceId: string | null;
  readonly model: string;
  readonly order: ReadonlyArray<HermesTier>;
  readonly disabled: ReadonlyArray<HermesTier>;
  readonly transports: ReadonlyArray<HermesTransportClaim>;
}): HermesLegacySelectionPatch | null {
  if ((input.instanceId ?? "").trim()) return null;
  // A board with an untouched chain has no legacy choice to preserve — it is a
  // fresh box, and the head of the tier list is not a choice anybody made. It
  // ships with the instance the default model belongs to, so the first tick
  // asks Grok for a Grok model rather than asking Cursor for one.
  const shipped = input.transports.find(
    (transport) => transport.driver === DEFAULT_HERMES_BRAIN_INSTANCE_ID,
  );
  if (shipped && !customisedChain({ ...input, shippedTier: shipped.tier })) {
    return { hermesBrainInstanceId: DEFAULT_HERMES_BRAIN_INSTANCE_ID };
  }
  const head = legacyHead({ order: input.order, disabled: input.disabled });
  if (head === null) return null;
  const claim = input.transports.find((transport) => transport.tier === head);
  if (!claim) return null;

  const model = input.model.trim();
  const prefix = claim.modelPrefix;
  return {
    hermesBrainInstanceId: claim.driver ?? claim.tier,
    ...(prefix && !model.startsWith(prefix) ? { hermesBrainModel: `${prefix}${model}` } : {}),
  };
}
