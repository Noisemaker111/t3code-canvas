import type {
  BoardRuleRow,
  HermesComponentRules,
  HermesRuleStat,
  ComponentId,
} from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  ACTION_LABELS,
  ACTIONS,
  TRIGGERS,
  defaultRules,
  TRIGGER_LABELS,
  rulesPatch,
  effectiveRules,
  ruleIdForRow,
} from "@t3tools/shared/boardRules";
import { CARD_VIEWS, CARD_VIEW_LABELS } from "./CardTileView";
import { readBoardSettings, updateBoardSettings } from "../../lib/boardSettings";
import { fetchHermesBrainStatus } from "../../lib/hermesBrain";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Input } from "../ui/input";
import { columnTitleFromId } from "../canvas/panels/boardColumns";
import { useBoardColumnView, useBoardContext } from "./KanbanBoard";

/**
 * A column's logic as editable When/Then rows.
 *
 * Every row is `when <trigger> then <action>` built from two Selects (plus a
 * column picker when the action is `moveTo`), so the behavior a drop used to
 * hardcode — launch on Active, open PR, merge on Done — is something you
 * rewire per column. Saving writes `boardSettings.columnRules` — the rows are
 * the only writer, so the Hermes tick reads exactly what is shown here. Each
 * Hermes-run row also carries its fire count and when it last fired.
 */

interface RuleVocabulary {
  readonly triggers: ReadonlyArray<string>;
  readonly actions: ReadonlyArray<string>;
  readonly newRow: BoardRuleRow;
}

const COLUMN_VOCABULARY: RuleVocabulary = {
  triggers: TRIGGERS,
  actions: ACTIONS,
  newRow: { when: "cardArrives", then: "moveHere", arg: "" },
};

/** What an action's `arg` starts as when a row is switched to it. */
const NEW_ROW_ARG: Record<string, string> = { moveTo: "active", display: "compact" };

function ruleKey(rule: BoardRuleRow, index: number): string {
  return `${index}:${rule.when}:${rule.then}:${rule.arg}`;
}

function agoLabel(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * What this row has actually done. A rule you cannot tell apart from a rule
 * that never fires is the whole reason the dialog was hard to trust.
 */
function FireStat({
  id,
  stats,
}: {
  readonly id: string;
  readonly stats: ReadonlyArray<HermesRuleStat> | null;
}) {
  if (stats === null) return null;
  const stat = stats.find((entry) => entry.rule === id);
  const fired = stat?.fired ?? 0;
  return (
    <span
      className="shrink-0 text-[10px] tabular-nums text-muted-foreground"
      title={
        fired === 0
          ? `Hermes has not run "${id}" since the counters were reset.`
          : `${id} · last fired ${stat?.lastFiredAt ?? "unknown"}`
      }
    >
      {fired === 0
        ? "never fired"
        : `${fired}× · ${stat?.lastFiredAt ? agoLabel(stat.lastFiredAt) : "—"}`}
    </span>
  );
}

function RuleFireCount({
  rule,
  stats,
}: {
  readonly rule: BoardRuleRow;
  readonly stats: ReadonlyArray<HermesRuleStat> | null;
}) {
  const id = ruleIdForRow(rule);
  if (id === null) return null;
  return <FireStat id={id} stats={stats} />;
}

/**
 * Every rule this component runs, read off the board itself.
 *
 * This used to be a list kept by hand beside the code (`COLUMN_BUILTIN_BEHAVIORS`)
 * describing what `rulePass.ts` did, and it went stale by construction: it said
 * nothing about a component somebody added and it kept naming behaviors a board
 * had switched off. The server builds its components out of rules and reports
 * them, so this is what actually runs here — if a behavior is not listed, it
 * does not happen.
 */
function ComponentRules({
  listing,
  stats,
}: {
  readonly listing: HermesComponentRules | null;
  readonly stats: ReadonlyArray<HermesRuleStat> | null;
}) {
  if (listing === null) return null;
  return (
    <div className="mt-3 border-t border-border/60 pt-2">
      <p className="pb-1.5 text-[11px] font-medium text-muted-foreground">What this runs</p>
      {listing.rules.length === 0 ? (
        <p className="pb-1 text-[11px] text-muted-foreground">
          Nothing. Cards sit here until you give it rules.
        </p>
      ) : (
        <ul className="space-y-1.5 pb-1">
          {listing.rules.map((entry) => (
            <li
              key={entry.name}
              className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground"
            >
              <span>{entry.name}</span>
              {entry.id === null ? null : <FireStat id={entry.id} stats={stats} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RuleRows({
  rows,
  setRows,
  vocabulary,
  moveToExcludes,
  ruleStats = null,
}: {
  readonly rows: ReadonlyArray<BoardRuleRow>;
  readonly setRows: (
    next: (prev: ReadonlyArray<BoardRuleRow>) => ReadonlyArray<BoardRuleRow>,
  ) => void;
  readonly vocabulary: RuleVocabulary;
  /** The column a `moveTo` must not point back at, when editing a column. */
  readonly moveToExcludes?: ComponentId;
  /** Per-rule fire counts from Hermes. Null while they are still loading. */
  readonly ruleStats?: ReadonlyArray<HermesRuleStat> | null;
}) {
  const columns = useBoardContext()?.columns ?? [];
  // A `moveTo` can point at a column this board has no panel for — a rule
  // written before the column was closed. The row still names it rather than
  // rendering a blank target.
  const columnLabel = (id: string) =>
    columns.find((entry) => entry.id === id)?.title ?? columnTitleFromId(id);
  const setRow = (index: number, patch: Partial<BoardRuleRow>) => {
    setRows((prev) => prev.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };

  return (
    <>
      <ul className="space-y-2 pb-2">
        {rows.map((rule, index) => (
          <li key={ruleKey(rule, index)} className="flex flex-wrap items-center gap-1.5">
            <span className="w-10 shrink-0 text-[11px] text-muted-foreground">when</span>
            <Select
              value={rule.when}
              onValueChange={(value) => {
                if (typeof value === "string") setRow(index, { when: value });
              }}
            >
              <SelectTrigger size="sm" className="min-w-[10rem] flex-1" aria-label="Trigger">
                <SelectValue>{TRIGGER_LABELS[rule.when] ?? rule.when}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {vocabulary.triggers.map((trigger) => (
                  <SelectItem hideIndicator key={trigger} value={trigger}>
                    {TRIGGER_LABELS[trigger] ?? trigger}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <span className="shrink-0 text-[11px] text-muted-foreground">then</span>
            <Select
              value={rule.then}
              onValueChange={(value) => {
                if (typeof value !== "string") return;
                setRow(index, { then: value, arg: NEW_ROW_ARG[value] ?? "" });
              }}
            >
              <SelectTrigger size="sm" className="min-w-[10rem] flex-1" aria-label="Action">
                <SelectValue>{ACTION_LABELS[rule.then] ?? rule.then}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {vocabulary.actions.map((action) => (
                  <SelectItem hideIndicator key={action} value={action}>
                    {ACTION_LABELS[action] ?? action}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {rule.then === "moveTo" ? (
              <Select
                value={rule.arg}
                onValueChange={(value) => {
                  if (typeof value === "string") setRow(index, { arg: value });
                }}
              >
                <SelectTrigger size="sm" className="w-24 shrink-0" aria-label="Target column">
                  <SelectValue>{columnLabel(rule.arg)}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {columns
                    .filter((entry) => entry.id !== moveToExcludes)
                    .map((entry) => (
                      <SelectItem hideIndicator key={entry.id} value={entry.id}>
                        {entry.title}
                      </SelectItem>
                    ))}
                </SelectPopup>
              </Select>
            ) : null}
            {rule.then === "display" ? (
              <Select
                value={rule.arg}
                onValueChange={(value) => {
                  if (typeof value === "string") setRow(index, { arg: value });
                }}
              >
                <SelectTrigger size="sm" className="w-28 shrink-0" aria-label="Card face">
                  <SelectValue>
                    {CARD_VIEW_LABELS[rule.arg] ?? rule.arg}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {Object.keys(CARD_VIEWS).map((entry) => (
                    <SelectItem hideIndicator key={entry} value={entry}>
                      {CARD_VIEW_LABELS[entry] ?? entry}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            <RuleFireCount rule={rule} stats={ruleStats} />
            {vocabulary.triggers.includes(rule.when) &&
            vocabulary.actions.includes(rule.then) ? null : (
              <span
                className="shrink-0 text-[10px] text-amber-700 dark:text-amber-300"
                title="This build does not run this row; it is kept for whatever wrote it."
              >
                unknown
              </span>
            )}
            <button
              type="button"
              aria-label="Remove rule"
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
              onClick={() => setRows((prev) => prev.filter((_, at) => at !== index))}
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="gap-1"
        onClick={() => setRows((prev) => [...prev, vocabulary.newRow])}
      >
        <PlusIcon className="size-3.5" />
        Add rule
      </Button>
    </>
  );
}

export function ColumnRulesDialog({
  column,
  onOpenChange,
  onRename,
}: {
  readonly column: ComponentId | null;
  readonly onOpenChange: (open: boolean) => void;
  /** Writes the name onto the column's panel — the column *is* that panel. */
  readonly onRename: (column: ComponentId, title: string) => void;
}) {
  const meta = useBoardColumnView(column ?? "");
  const [rows, setRows] = useState<ReadonlyArray<BoardRuleRow>>([]);
  const [ruleStats, setRuleStats] = useState<ReadonlyArray<HermesRuleStat> | null>(null);
  const [listing, setListing] = useState<HermesComponentRules | null>(null);

  useEffect(() => {
    if (column === null) return;
    setRows(effectiveRules(readBoardSettings(), column));
  }, [column]);

  useEffect(() => {
    if (column === null) return;
    let cancelled = false;
    void fetchHermesBrainStatus()
      .then((status) => {
        if (cancelled) return;
        setRuleStats(status.stats.rules);
        setListing(status.componentRules?.find((entry) => entry.at === column) ?? null);
      })
      // Counts are commentary on the rows; a brain that cannot answer must not
      // stop you editing them. The rows render without them.
      .catch(() => {
        if (cancelled) return;
        setRuleStats(null);
        setListing(null);
      });
    return () => {
      cancelled = true;
    };
  }, [column]);

  if (column === null) return null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl" showCloseButton>
        <DialogHeader className="gap-1 p-4 pb-2 sm:p-5 sm:pb-2">
          <DialogTitle className="text-base">{meta.title}</DialogTitle>
          <p className="text-xs text-muted-foreground">
            What this column does. A drop runs the <span className="font-mono">cardArrives</span>{" "}
            row, and a <span className="font-mono">display</span> row picks the face its cards wear;
            every other row is the Hermes tick's, and says how often it has fired. Below the rows:
            what the tick's code always does here.
          </p>
        </DialogHeader>
        <DialogPanel scrollFade className="max-h-[60vh] px-4 py-2 sm:px-5">
          <div className="flex items-center gap-2 pb-3">
            <Input
              value={meta.title}
              aria-label="Column name"
              data-testid="column-rules-name"
              className="h-8"
              onChange={(event) => onRename(column, event.target.value)}
            />
            <code className="shrink-0 rounded bg-muted px-1.5 py-1 font-mono text-[10px] text-muted-foreground">
              {column}
            </code>
          </div>
          <RuleRows
            rows={rows}
            setRows={(next) => setRows(next)}
            vocabulary={COLUMN_VOCABULARY}
            moveToExcludes={column}
            ruleStats={ruleStats}
          />
          <ComponentRules listing={listing} stats={ruleStats} />
        </DialogPanel>
        <DialogFooter
          variant="bare"
          className="flex-row items-center justify-between gap-2 border-t border-border/60 px-4 py-2.5 sm:px-5"
        >
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setRows(defaultRules(column))}
          >
            Reset to defaults
          </Button>
          <Button
            type="button"
            size="xs"
            onClick={() => {
              updateBoardSettings(rulesPatch(readBoardSettings(), column, rows));
              onOpenChange(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
