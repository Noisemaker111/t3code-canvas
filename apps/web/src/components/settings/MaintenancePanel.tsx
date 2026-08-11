import { EraserIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  fetchMaintenance,
  formatBytes,
  purgeMaintenanceTarget,
  type MaintenanceSurvey,
  type MaintenanceTargetId,
} from "../../lib/maintenance";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  readBoardSettings,
  subscribeBoardSettings,
  updateBoardSettings,
} from "../../lib/boardSettings";
import { SettingsRow, SettingsSection, settingsPageShell } from "./settingsLayout";

/** Order on the page. Canvas sits last and alone, under its own heading. */
const ORDER: ReadonlyArray<MaintenanceTargetId> = [
  "friction",
  "archived",
  "hermes-logs",
  "health",
  "canvas",
];

const ACTION_LABELS: Record<MaintenanceTargetId, string> = {
  friction: "Clear friction log",
  archived: "Purge archived history",
  "hermes-logs": "Clear Hermes logs",
  health: "Clear incident log",
  canvas: "Wipe canvas",
};

/**
 * Orphan-worktree sweep policy — the 40GiB-store-incident knob. Each orphaned
 * workspace is a full dependency install; the sweep reclaims clean ones on
 * every launch, and these two settings decide what happens to dirty ones.
 */
function WorktreeSweepSection() {
  const [board, setBoard] = useState(() => readBoardSettings());
  useEffect(() => subscribeBoardSettings(setBoard), []);

  return (
    <SettingsSection title="Worktree sweep" icon={<EraserIcon className="size-3.5" />}>
      <SettingsRow
        title="Reap abandoned dirty worktrees"
        description="An orphaned workspace with uncommitted changes is kept and reported by default. On, it is reclaimed once it passes the retention window with no writes. T3CODE_WORKTREE_REAP_ABANDONED overrides this when set."
        control={
          <Switch
            checked={board.worktreeReapAbandoned}
            onCheckedChange={(checked) =>
              updateBoardSettings({ worktreeReapAbandoned: Boolean(checked) })
            }
          />
        }
      />
      <SettingsRow
        title="Retention window"
        description="How long an untouched dirty orphan is kept before it counts as abandoned. T3CODE_WORKTREE_RETENTION_HOURS overrides this when set."
        control={
          <div className="flex items-center gap-2">
            <input
              type="number"
              aria-label="Retention window"
              min={1}
              step={1}
              className="h-8 w-20 rounded-md bg-raised px-2 text-xs tabular-nums outline-none focus:border-ring"
              value={board.worktreeRetentionHours}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next) && next > 0) {
                  updateBoardSettings({ worktreeRetentionHours: next });
                }
              }}
            />
            <span className="text-xs text-muted-foreground">hours</span>
          </div>
        }
      />
    </SettingsSection>
  );
}

function sizeNote(survey: MaintenanceSurvey): string {
  if (survey.items === 0) return "Nothing to delete.";
  const bytes = survey.bytes > 0 ? ` · about ${formatBytes(survey.bytes)}` : "";
  return `${survey.items.toLocaleString()} item${survey.items === 1 ? "" : "s"}${bytes}`;
}

/**
 * The confirmation. It names the target, every count inside it, and — for the
 * canvas — refuses to enable until the phrase is typed. There is no bare
 * "are you sure?" path to any of these.
 */
function ConfirmPurgeDialog({
  survey,
  busy,
  onCancel,
  onConfirm,
}: {
  survey: MaintenanceSurvey;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (phrase: string) => void;
}) {
  const [phrase, setPhrase] = useState("");
  const needsPhrase = survey.requiresPhrase !== null;
  const phraseOk =
    !needsPhrase || phrase.trim().toLowerCase() === survey.requiresPhrase?.toLowerCase();

  return (
    <AlertDialog
      open
      onOpenChange={(open: boolean) => {
        if (!open && !busy) onCancel();
      }}
    >
      <AlertDialogPopup data-testid="maintenance-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <TriangleAlertIcon className="size-4 text-destructive" />
            Delete {survey.items.toLocaleString()} item
            {survey.items === 1 ? "" : "s"} from {survey.title}?
          </AlertDialogTitle>
          <AlertDialogDescription>{survey.summary} This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3 px-6 pb-4">
          <ul className="divide-y divide-border/60 rounded-md border bg-muted/40 font-mono text-[11px]">
            {survey.lines.map((line) => (
              <li key={line.label} className="flex items-center justify-between gap-3 px-3 py-1.5">
                <span className="truncate text-muted-foreground">{line.label}</span>
                <span className="shrink-0 tabular-nums text-foreground">
                  {line.count.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
          {survey.bytes > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Frees roughly {formatBytes(survey.bytes)}.
            </p>
          ) : null}
          {needsPhrase ? (
            <div className="space-y-1.5">
              <label
                className="block text-xs font-medium text-foreground"
                htmlFor="maintenance-confirm-phrase"
              >
                Type <span className="font-mono text-destructive">{survey.requiresPhrase}</span> to
                confirm
              </label>
              <Input
                id="maintenance-confirm-phrase"
                autoComplete="off"
                value={phrase}
                placeholder={survey.requiresPhrase ?? ""}
                onChange={(event) => setPhrase(event.target.value)}
              />
            </div>
          ) : null}
        </div>
        <AlertDialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !phraseOk}
            onClick={() => onConfirm(phrase)}
          >
            {busy ? "Deleting…" : `Delete ${survey.items.toLocaleString()}`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

export function MaintenancePanel({ embedded = false }: { embedded?: boolean } = {}) {
  const [surveys, setSurveys] = useState<ReadonlyArray<MaintenanceSurvey>>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<MaintenanceTargetId | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await fetchMaintenance();
      setSurveys(result.surveys);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read what is stored.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byTarget = useMemo(
    () => new Map(surveys.map((survey) => [survey.target, survey])),
    [surveys],
  );
  const pendingSurvey = pending === null ? null : (byTarget.get(pending) ?? null);

  const purge = useCallback(
    async (survey: MaintenanceSurvey, phrase: string) => {
      setBusy(true);
      try {
        const { result } = await purgeMaintenanceTarget({
          target: survey.target,
          confirmItems: survey.items,
          ...(survey.requiresPhrase === null ? {} : { confirmPhrase: phrase }),
        });
        toastManager.add({
          type: "success",
          title: `${result.title} cleared`,
          description: `${result.items.toLocaleString()} item${result.items === 1 ? "" : "s"} deleted.`,
        });
        setPending(null);
        await load();
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "Nothing was deleted",
          description: cause instanceof Error ? cause.message : String(cause),
        });
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const rowsFor = (targets: ReadonlyArray<MaintenanceTargetId>) =>
    ORDER.filter((target) => targets.includes(target)).map((target) => {
      const survey = byTarget.get(target);
      if (!survey) return null;
      return (
        <SettingsRow
          key={target}
          title={survey.title}
          description={survey.summary}
          status={sizeNote(survey)}
          control={
            <Button
              variant={target === "canvas" ? "destructive" : "outline"}
              size="sm"
              disabled={survey.items === 0}
              onClick={() => setPending(target)}
            >
              {ACTION_LABELS[target]}
            </Button>
          }
        />
      );
    });

  return settingsPageShell(
    embedded,
    <>
      <SettingsSection
        title="Stored history"
        icon={<EraserIcon className="size-3.5" />}
        headerAction={
          <Button size="icon-xs" variant="ghost" aria-label="Refresh" onClick={() => void load()}>
            <RefreshCwIcon className="size-3.5" />
          </Button>
        }
      >
        {error ? (
          <p className="px-4 py-3 text-xs text-destructive sm:px-5">{error}</p>
        ) : surveys.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground sm:px-5">Reading…</p>
        ) : (
          rowsFor(["friction", "archived", "hermes-logs", "health"])
        )}
      </SettingsSection>

      <WorktreeSweepSection />

      <SettingsSection title="Canvas" icon={<TriangleAlertIcon className="size-3.5" />}>
        <div className="border-b border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
          The canvas is never wiped automatically — not on a schedule, not on startup, and not as a
          side effect of anything else on this page. This button is the only thing that does it.
        </div>
        {surveys.length === 0 ? null : rowsFor(["canvas"])}
      </SettingsSection>

      {pendingSurvey === null ? null : (
        <ConfirmPurgeDialog
          survey={pendingSurvey}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={(phrase) => void purge(pendingSurvey, phrase)}
        />
      )}
    </>,
  );
}
