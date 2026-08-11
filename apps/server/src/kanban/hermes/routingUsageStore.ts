// @effect-diagnostics nodeBuiltinImport:off
/**
 * Learned percentage-of-capacity observations for semantic routing.
 * Co-located with the measured budget store when one is bound; otherwise it
 * remains an honest process-local cache.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { HermesCapacityPool } from "@t3tools/contracts";

import { hermesBudgetTablePath } from "../budget/budgetStore.ts";
import type { LearnedUsageSample } from "./routeFacts.ts";

export type RoutingUsageSample = LearnedUsageSample & {
  readonly cardId: string;
  readonly poolId: string;
  readonly at: string;
  readonly confidence: "measured" | "estimated";
};

type PendingUsageObservation = {
  readonly cardId: string;
  readonly routeId: string;
  readonly poolId: string;
  readonly remainingPercent: number;
  readonly startedAt: string;
};

type RoutingUsageFile = {
  readonly samples: ReadonlyArray<RoutingUsageSample>;
  readonly pending: ReadonlyArray<PendingUsageObservation>;
};

const RoutingUsageSampleSchema = Schema.Struct({
  cardId: Schema.String,
  routeId: Schema.String,
  poolId: Schema.String,
  observedPercent: Schema.Number,
  at: Schema.String,
  confidence: Schema.Literals(["measured", "estimated"]),
});
const PendingUsageObservationSchema = Schema.Struct({
  cardId: Schema.String,
  routeId: Schema.String,
  poolId: Schema.String,
  remainingPercent: Schema.Number,
  startedAt: Schema.String,
});
const RoutingUsageFileSchema = Schema.Struct({
  samples: Schema.Array(RoutingUsageSampleSchema),
  pending: Schema.Array(PendingUsageObservationSchema),
});
const decodeRoutingUsageFile = Schema.decodeUnknownOption(RoutingUsageFileSchema);
const decodeLegacyRoutingUsage = Schema.decodeUnknownOption(
  Schema.Array(RoutingUsageSampleSchema),
);

const LIMIT = 300;
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
let memory: RoutingUsageFile = { samples: [], pending: [] };
let loadedFrom: string | null = null;

function path(): string | null {
  const budget = hermesBudgetTablePath();
  return budget ? NodePath.join(NodePath.dirname(budget), "routing-usage.json") : null;
}

function read(): RoutingUsageFile {
  const file = path();
  if (!file) return memory;
  if (loadedFrom === file) return memory;
  loadedFrom = file;
  try {
    const json: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    const parsed = decodeRoutingUsageFile(json);
    if (Option.isSome(parsed)) {
      memory = {
        samples: parsed.value.samples.slice(-LIMIT),
        pending: parsed.value.pending,
      };
    } else {
      memory = Option.match(decodeLegacyRoutingUsage(json), {
        onNone: () => ({ samples: [], pending: [] }),
        onSome: (samples) => ({ samples: samples.slice(-LIMIT), pending: [] }),
      });
    }
  } catch {
    memory = { samples: [], pending: [] };
  }
  return memory;
}

function write(next: RoutingUsageFile): void {
  memory = { samples: next.samples.slice(-LIMIT), pending: next.pending };
  const file = path();
  if (!file) return;
  try {
    const temporary = `${file}.tmp-${process.pid}`;
    NodeFS.writeFileSync(temporary, `${JSON.stringify(memory)}\n`, "utf8");
    NodeFS.renameSync(temporary, file);
  } catch {
    // Measurement persistence must never stop a launch.
  }
}

function currentState(at: string | undefined): RoutingUsageFile {
  const state = read();
  const fallbackNow = DateTime.nowUnsafe().epochMilliseconds;
  const parsedAt = at ? Date.parse(at) : fallbackNow;
  const now = Number.isFinite(parsedAt) ? parsedAt : fallbackNow;
  return {
    samples: state.samples,
    pending: state.pending.filter((entry) => {
      const startedAt = Date.parse(entry.startedAt);
      return Number.isFinite(startedAt) && now - startedAt <= PENDING_MAX_AGE_MS;
    }),
  };
}

export function routingUsageSamples(): ReadonlyArray<RoutingUsageSample> {
  return read().samples;
}

export function beginRoutingUsageObservation(input: {
  readonly cardId: string;
  readonly routeId: string;
  readonly pool: HermesCapacityPool;
  readonly at?: string;
}): void {
  if (input.pool.remainingPercent === null) return;
  const state = currentState(input.at);
  write({
    samples: state.samples,
    pending: [
      ...state.pending.filter((entry) => entry.cardId !== input.cardId),
      {
        cardId: input.cardId,
        routeId: input.routeId,
        poolId: input.pool.id,
        remainingPercent: input.pool.remainingPercent,
        startedAt: input.at ?? DateTime.formatIso(DateTime.nowUnsafe()),
      },
    ],
  });
}

export function finishRoutingUsageObservation(input: {
  readonly cardId: string;
  readonly pool: HermesCapacityPool;
  readonly at?: string;
}): RoutingUsageSample | null {
  const state = currentState(input.at);
  const pending = state.pending.find((entry) => entry.cardId === input.cardId);
  if (
    !pending ||
    input.pool.id !== pending.poolId ||
    input.pool.remainingPercent === null
  ) {
    return null;
  }
  // A reset or overlapping work makes attribution impossible. Remove this
  // pending observation without teaching the estimator a fabricated number.
  const overlapping = state.pending.filter(
    (entry) => entry.poolId === pending.poolId && entry.cardId !== pending.cardId,
  );
  if (input.pool.remainingPercent > pending.remainingPercent || overlapping.length > 0) {
    write({
      samples: state.samples,
      pending: state.pending.filter((entry) => entry.cardId !== input.cardId),
    });
    return null;
  }
  const observedPercent = pending.remainingPercent - input.pool.remainingPercent;
  if (observedPercent <= 0) {
    write({
      samples: state.samples,
      pending: state.pending.filter((entry) => entry.cardId !== input.cardId),
    });
    return null;
  }
  const sample: RoutingUsageSample = {
    cardId: input.cardId,
    routeId: pending.routeId,
    poolId: pending.poolId,
    observedPercent,
    at: input.at ?? DateTime.formatIso(DateTime.nowUnsafe()),
    confidence: "estimated",
  };
  write({
    samples: [...state.samples, sample],
    pending: state.pending.filter((entry) => entry.cardId !== input.cardId),
  });
  return sample;
}
