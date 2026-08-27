"use client";

import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type {
  BoardModelRosterEntry,
  ModelCapabilities,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import {
  BrainIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  GaugeIcon,
  PlusIcon,
  XIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "../../../lib/utils";
import {
  readBoardSettings,
  subscribeBoardSettings,
  updateBoardSettings,
  type BoardSettings,
} from "../../../lib/boardSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../../providerInstances";
import { getAppModelOptionsForInstance } from "../../../modelSelection";
import { providerUsageUnusableReason } from "../../../lib/providerUsage";
import { useUsageSnapshot } from "../../../hooks/useUsageSnapshot";
import { usePrimarySettings } from "../../../hooks/useSettings";
import {
  axisChips,
  costPerTaskDetail,
  formatCostPerTask,
  formatRouteCost,
  formatRouteHeadroom,
  formatRouteSpeed,
  formatRouteThroughput,
  formatRouteUsage,
  formatTimePerTask,
  routeFactsKey,
  useModelRouteFacts,
  type ModelRouteFacts,
} from "../../../lib/modelRouteFacts";
import { primaryServerProvidersAtom } from "../../../state/server";
import { BoardModelPicker } from "../../kanban/ComposerModelPreset";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Toggle } from "../../ui/toggle";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import {
  addToRoster,
  isOnRoster,
  moveRosterEntry,
  removeRosterEntry,
  rosterKey,
  ROSTER_NOTE_MAX,
  rulesClaimingMeasuredFacts,
  rulesMissingNotes,
  setRosterEffortRange,
  setRosterModel,
  setRosterNote,
  setRosterOption,
} from "./modelRoster.logic";

type AvailableModel = {
  readonly instanceId: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities | null;
};

/** An icon carries the knob's identity so the row shows the value, not a label. */
const OPTION_ICONS: Record<string, LucideIcon> = {
  effort: BrainIcon,
  fastMode: ZapIcon,
  thinking: BrainIcon,
};

/**
 * Thinking effort, fast mode and any other knob the model exposes, rendered
 * from the provider's own descriptors so a rule can only save an option that
 * model actually accepts. Returns bare controls: the rule row is the flex
 * container, so every knob sits on the same line as the sentence and model.
 */
export function RuleOptions({
  capabilities,
  options,
  effortRange,
  onChange,
  onEffortRangeChange,
}: {
  capabilities: ModelCapabilities | null;
  options: ReadonlyArray<ProviderOptionSelection>;
  effortRange: { readonly min: string; readonly max: string } | null;
  onChange: (option: ProviderOptionSelection) => void;
  onEffortRangeChange: (range: { min: string; max: string }) => void;
}) {
  const descriptors = useMemo(
    () =>
      capabilities ? getProviderOptionDescriptors({ caps: capabilities, selections: options }) : [],
    [capabilities, options],
  );
  if (descriptors.length === 0) return null;

  return (
    <>
      {descriptors.map((descriptor) => {
        const current = getProviderOptionCurrentValue(descriptor);
        const Icon = OPTION_ICONS[descriptor.id];
        // The thinking knob is a band, not a value: equal ends pin a level,
        // a wider band hands the level to the router (size + quota headroom).
        if (descriptor.type === "select" && descriptor.id === "effort") {
          const fixed = typeof current === "string" ? current : "";
          const min = effortRange?.min ?? fixed;
          const max = effortRange?.max ?? fixed;
          const endpoint = (which: "min" | "max", value: string, label: string) => (
            <Select
              value={value}
              onValueChange={(next) => {
                if (typeof next !== "string" || next.length === 0) return;
                const ids = descriptor.options.map((choice) => choice.id);
                const low = which === "min" ? next : min || next;
                const high = which === "max" ? next : max || next;
                // Keep the band ordered the way the model declares its levels.
                const ordered =
                  ids.indexOf(low) <= ids.indexOf(high)
                    ? { min: low, max: high }
                    : { min: high, max: low };
                onEffortRangeChange(ordered);
              }}
            >
              <SelectTrigger
                aria-label={label}
                title={label}
                size="sm"
                className="w-auto min-w-0 shrink-0 gap-1"
              >
                {which === "min" && Icon ? <Icon className="size-3.5" aria-hidden /> : null}
                <span className="truncate text-xs">
                  {descriptor.options.find((choice) => choice.id === value)?.label ?? value ?? "…"}
                </span>
              </SelectTrigger>
              <SelectPopup>
                {descriptor.options.map((choice) => (
                  <SelectItem key={choice.id} value={choice.id}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          );
          return (
            <span key={descriptor.id} className="flex shrink-0 items-center gap-0.5">
              {endpoint("min", min, "Thinking from")}
              <span className="text-[10px] text-muted-foreground">…</span>
              {endpoint("max", max, "Thinking to")}
            </span>
          );
        }
        if (descriptor.type === "boolean") {
          const on = current === true;
          return (
            <Toggle
              key={descriptor.id}
              size="sm"
              variant="outline"
              pressed={on}
              onPressedChange={(pressed) => onChange({ id: descriptor.id, value: pressed })}
              aria-label={descriptor.label}
              title={`${descriptor.label}: ${on ? "on" : "off"}`}
              className={cn(
                "shrink-0",
                on && "border-amber-500/40 [&_svg]:text-amber-500 [&_svg]:opacity-100",
              )}
            >
              {Icon ? (
                <Icon className="size-3.5" aria-hidden />
              ) : (
                <span className="px-1 text-xs">{descriptor.label}</span>
              )}
            </Toggle>
          );
        }
        return (
          <Select
            key={descriptor.id}
            value={typeof current === "string" ? current : ""}
            onValueChange={(value) => {
              if (typeof value === "string" && value.length > 0) {
                onChange({ id: descriptor.id, value });
              }
            }}
          >
            <SelectTrigger
              aria-label={descriptor.label}
              title={descriptor.label}
              size="sm"
              className="w-auto min-w-0 shrink-0 gap-1"
            >
              {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
              <span className="truncate text-xs">
                {getProviderOptionCurrentLabel(descriptor) ?? current}
              </span>
            </SelectTrigger>
            <SelectPopup>
              {descriptor.options.map((choice) => (
                <SelectItem key={choice.id} value={choice.id}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        );
      })}
    </>
  );
}

/**
 * Capability, cost, speed and usage as the router measured them. Rendered so the
 * sentence above it never has to carry them — a hand-typed "High IQ, $$$" is a
 * guess the box can already answer from the benchmark snapshot, the price
 * catalog and its own observed turns.
 */
function RouteFactsLine({ facts }: { facts: ModelRouteFacts | undefined }) {
  const headroom = formatRouteHeadroom(facts);
  const benchmarked = axisChips(facts);
  const benchTitle = facts?.benchSource ?? "no capability snapshot on this box";
  const chips = [
    // One chip per benchmarked axis; a model no feed has scored says so once,
    // rather than printing four separate unknowns.
    ...(benchmarked.length > 0
      ? benchmarked.map((chip) => ({ text: chip.text, known: true, title: benchTitle }))
      : [{ text: "bench unknown", known: false, title: benchTitle }]),
    {
      text: formatCostPerTask(facts),
      known: facts?.usdPerTask != null,
      title: costPerTaskDetail(facts),
    },
    {
      text: formatRouteCost(facts),
      known: facts?.costBasis === "measured",
      title: facts?.priceSource ?? "no price source",
    },
    {
      text: formatRouteSpeed(facts),
      known: facts?.medianTurnMs != null,
      title: `${facts?.speedSamples ?? 0} observed turns`,
    },
    {
      text: formatRouteThroughput(facts),
      known: facts?.tokensPerSecond != null,
      title: `median output tokens per second over ${facts?.throughputSamples ?? 0} turns — emission speed, not time to done`,
    },
    // Next to tok/s on purpose: this is the chip that says whether the job
    // actually landed sooner. A route can emit faster and still finish later.
    {
      text: formatTimePerTask(facts),
      known: facts?.msPerTask != null,
      title: `wall-clock of the median task over ${facts?.taskCount ?? 0} observed tasks`,
    },
    {
      text: formatRouteUsage(facts),
      known: facts?.usagePercent != null,
      title: facts?.usageBasis ?? "no comparable tasks observed",
    },
    ...(headroom
      ? [{ text: headroom, known: true, title: "remaining share of the binding allowance" }]
      : []),
  ];
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 ps-6 font-mono text-[10px]">
      {chips.map((chip) => (
        <span
          key={chip.text}
          title={chip.title}
          className={chip.known ? "text-muted-foreground" : "text-muted-foreground/50"}
        >
          {chip.text}
        </span>
      ))}
    </div>
  );
}

/**
 * The rules: one sentence per model saying what it is for, in preference order.
 * Free text on purpose — Hermes and every launched thread read these sentences,
 * so the owner writes the routing policy instead of picking from fixed roles.
 * Capability, cost, speed and usage are not the owner's to type: the measured
 * row under each rule carries them.
 */
export function ModelRosterSection() {
  const [settings, setSettings] = useState<BoardSettings>(() => readBoardSettings());
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const unified = usePrimarySettings();
  const usageSnapshot = useUsageSnapshot();

  useEffect(() => subscribeBoardSettings(setSettings), []);

  const roster = settings.modelRoster;
  const enforced = settings.modelRosterEnforced;

  // Same verdict as `useProviderInstancePicker`: settings-authoritative enable,
  // availability, usage hard-blocks, hidden/custom models — not just the probe.
  const available = useMemo<ReadonlyArray<AvailableModel>>(
    () =>
      applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), unified)
        .filter(
          (entry) =>
            entry.enabled &&
            entry.installed &&
            entry.isAvailable &&
            providerUsageUnusableReason(usageSnapshot.data, entry.instanceId) === null,
        )
        .flatMap((entry) => {
          const capabilitiesBySlug = new Map(
            entry.models.map((model) => [model.slug, model.capabilities ?? null]),
          );
          return getAppModelOptionsForInstance(unified, entry).map((option) => ({
            instanceId: entry.instanceId,
            model: option.slug,
            capabilities: capabilitiesBySlug.get(option.slug) ?? null,
          }));
        }),
    [serverProviders, unified, usageSnapshot.data],
  );

  const byKey = useMemo(
    () => new Map(available.map((entry) => [rosterKey(entry), entry])),
    [available],
  );

  const nextFree = useMemo(
    () => available.find((entry) => !isOnRoster(roster, entry)) ?? null,
    [available, roster],
  );

  const missingNotes = useMemo(() => rulesMissingNotes(roster), [roster]);
  const claimedFacts = useMemo(() => rulesClaimingMeasuredFacts(roster), [roster]);

  // Keyed by instance+model so a reorder never re-labels a row's evidence.
  const facts = useModelRouteFacts();

  const write = (next: ReadonlyArray<BoardModelRosterEntry>) =>
    setSettings(updateBoardSettings({ modelRoster: next }));

  return (
    <SettingsSection
      id="models.auto-router"
      title="Auto Router"
      icon={<GaugeIcon className="size-3.5" />}
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={!nextFree}
          onClick={() => nextFree && write(addToRoster(roster, nextFree))}
        >
          <PlusIcon className="size-3" />
          Add rule
        </Button>
      }
    >
      <div className="border-b border-border/60 bg-muted/20 px-4 py-3.5 sm:px-5">
        <p className="text-sm font-medium">Say what each model is for.</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          One sentence per model, in preference order, plus that model's thinking effort and fast
          mode. Say what you want it <em>for</em> — code, ops, design and planning scores, plus
          price, speed and usage, are measured and shown under each rule, so they never belong in
          the sentence. Hermes reads the rules when it routes a card, and a launch runs with the
          settings you pick here. This does not change the model Hermes itself uses to reason about
          the board.
        </p>
      </div>

      <SettingsRow
        title="Use these rules"
        description="Keep automatic board launches on the models listed below. Turn this off to let the router consider every enabled model."
        status={
          roster.length === 0
            ? "Add at least one rule to activate it."
            : enforced
              ? "Active for automatic board launches."
              : "Rules saved, but automatic launches may choose other enabled models."
        }
        control={
          <Switch
            aria-label="Use these model rules"
            checked={enforced}
            disabled={roster.length === 0}
            onCheckedChange={(checked) =>
              setSettings(updateBoardSettings({ modelRosterEnforced: checked }))
            }
          />
        }
      />

      {roster.length === 0 ? (
        <div className="border-t border-border/60 px-4 py-4 text-xs text-muted-foreground sm:px-5">
          No rules yet. Add one, describe what the model should be used for, and pick the model.
        </div>
      ) : (
        <ul className="divide-y divide-border/50 border-t border-border/60">
          {roster.map((entry, index) => {
            const known = byKey.get(rosterKey(entry));
            return (
              <li key={rosterKey(entry)} className="px-4 py-2 sm:px-5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="w-4 shrink-0 text-center font-mono text-[11px] text-muted-foreground">
                    {index + 1}
                  </span>
                  <Input
                    className="min-w-40 flex-1"
                    size="sm"
                    maxLength={ROSTER_NOTE_MAX}
                    value={entry.note}
                    spellCheck
                    aria-label={`What ${entry.model} is used for`}
                    placeholder="Used for quick UI fixes and copy changes."
                    onChange={(event) => write(setRosterNote(roster, index, event.target.value))}
                  />
                  {/* One unit so a tight panel wraps the whole cluster, never a lone button;
                      max-w-full + flex-wrap keep it inside a phone-width row. */}
                  <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
                    <BoardModelPicker
                      preset={{ instanceId: entry.instanceId, model: entry.model }}
                      onChange={(next) => next && write(setRosterModel(roster, index, next))}
                      triggerClassName="h-8 w-48 shrink-0 justify-between sm:h-7"
                    />
                    {/* Fixed lane: models expose different knobs, and without it
                        every row's sentence field ended at a different edge. */}
                    <div className="flex min-w-36 shrink-0 items-center gap-1.5">
                      <RuleOptions
                        capabilities={known?.capabilities ?? null}
                        options={entry.options}
                        effortRange={entry.effortRange ?? null}
                        onChange={(option) => write(setRosterOption(roster, index, option))}
                        onEffortRangeChange={(range) =>
                          write(setRosterEffortRange(roster, index, range))
                        }
                      />
                    </div>
                    <div className="flex shrink-0 items-center">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Move up"
                        disabled={index === 0}
                        onClick={() => write(moveRosterEntry(roster, index, -1))}
                      >
                        <ChevronUpIcon className="size-3" />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Move down"
                        disabled={index === roster.length - 1}
                        onClick={() => write(moveRosterEntry(roster, index, 1))}
                      >
                        <ChevronDownIcon className="size-3" />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Remove rule for ${entry.model}`}
                        onClick={() => write(removeRosterEntry(roster, index))}
                      >
                        <XIcon className="size-3" />
                      </Button>
                    </div>
                  </div>
                </div>
                <RouteFactsLine facts={facts.get(rosterKey(entry))} />
                {known ? null : (
                  <div className="mt-1 flex items-center gap-2 ps-6 text-[10px]">
                    <span className="truncate font-mono text-amber-600 dark:text-amber-400">
                      {entry.instanceId}/{entry.model} · not currently available
                    </span>
                    <Link
                      to="/kanban"
                      search={{ station: "settings:connections" }}
                      className="shrink-0 font-medium text-primary hover:underline"
                    >
                      Set up provider
                    </Link>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {missingNotes.length > 0 ? (
        <div className="border-t border-border/60 px-4 py-2 text-[11px] text-amber-600 dark:text-amber-400 sm:px-5">
          No sentence yet:{" "}
          {missingNotes
            .map((warning) => roster[warning.index]?.model ?? "")
            .filter(Boolean)
            .join(" · ")}{" "}
          — Hermes is never told when to pick those.
        </div>
      ) : null}

      {claimedFacts.length > 0 ? (
        <div className="border-t border-border/60 px-4 py-2 text-[11px] text-amber-600 dark:text-amber-400 sm:px-5">
          Dropped before Hermes reads the rule:{" "}
          {claimedFacts.map((warning) => warning.detail).join(" · ")}
        </div>
      ) : null}
    </SettingsSection>
  );
}
