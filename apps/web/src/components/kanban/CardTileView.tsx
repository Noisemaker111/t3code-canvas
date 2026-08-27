import type React from "react";

import type { CardRenderer } from "@t3tools/shared/boardRules";
import { cn } from "~/lib/utils";
import type { CardQueueState, PrCheckBadge } from "./KanbanBoard.logic";

/**
 * The board card's faces, with nothing behind them.
 *
 * Split out of `CardTile` so a state can be rendered from props alone. The board
 * still owns the hooks — the thread session, the drag handle, the interrupt
 * command — and hands the result down here; the dev gallery hands down a fixture
 * and gets the same pixels without a server, a thread or an LLM call.
 *
 * There is more than one face: a column's `cardArrives → display` rule row
 * picks which, and `CardView` is the one component the board mounts. Every face
 * takes the same props, so choosing one never changes what a card knows about
 * itself — only how much of it is drawn.
 */

/** Draft-only: yellow while skills are applying. */
export function DraftWorkingDot({ className }: { className?: string }) {
  return (
    <span
      title="Hermes applying skills…"
      className={cn(
        "size-2 shrink-0 rounded-full bg-amber-400 shadow-sm ring-1 ring-black/10 animate-pulse",
        className,
      )}
    />
  );
}

const QUEUE_TONE_CLASS: Record<CardQueueState["tone"], string> = {
  running: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  queued: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  idle: "bg-muted text-muted-foreground",
  blocked: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  applied: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};

export function QueueBadge({ state }: { state: CardQueueState }) {
  return (
    <span
      title={state.title}
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium",
        QUEUE_TONE_CLASS[state.tone],
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full bg-current",
          (state.pulse ?? state.tone === "queued") && "animate-pulse",
        )}
      />
      {state.label}
    </span>
  );
}

const PR_CHECK_TONE_CLASS: Record<PrCheckBadge["tone"], string> = {
  running: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  failed: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  passed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};

export function PrChecksBadge({
  badge,
  url,
}: {
  badge: PrCheckBadge;
  url?: string | null | undefined;
}) {
  const content = (
    <>
      <span className={cn("size-1.5 rounded-full bg-current", badge.pulse && "animate-pulse")} />
      {badge.label}
    </>
  );
  const className = cn(
    "inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium",
    PR_CHECK_TONE_CLASS[badge.tone],
  );
  if (!url) {
    return (
      <span title={badge.title} className={className}>
        {content}
      </span>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={badge.title}
      className={cn(className, "hover:underline")}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {content}
    </a>
  );
}

/** `#1450`: the card's PR, one click away, never a raw URL. */
function PrNumberBadge({
  number,
  url,
  className: extra,
}: {
  number: number;
  url?: string | null | undefined;
  className?: string;
}) {
  const className = cn("text-[10px] font-semibold tabular-nums text-primary", extra);
  if (!url) {
    return <span className={className}>#{number}</span>;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={url}
      className={cn(className, "hover:underline")}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      #{number}
    </a>
  );
}

/**
 * Why this card is where it is, when a rule put it there. Read off the card's
 * own history, so it survives a restart and a refresh — and it disappears the
 * moment a human moves the card, because then the last move is theirs.
 */
function RuleMoveBadge({ rule }: { readonly rule: string }) {
  return (
    <span
      className="shrink-0 truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground/80"
      title={`Hermes moved this card here — rule "${rule}"`}
    >
      by {rule}
    </span>
  );
}

function StopButton({
  onStop,
  className,
}: {
  readonly onStop: (event: React.MouseEvent) => void;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 transition-all duration-150 hover:bg-destructive hover:scale-105 active:scale-95",
        className,
      )}
      onClick={onStop}
      onPointerDown={(event) => event.stopPropagation()}
      aria-label="Stop generation"
    >
      <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <rect x="2" y="2" width="8" height="8" rx="1.5" />
      </svg>
    </button>
  );
}

/** The frame every face shares: the drag affordance, the drag and busy rings. */
/** Ping Hermes about this card: it answers in the Hermes panel, next beat. */
function PingButton({
  onPing,
  pinging = false,
  className,
}: {
  readonly onPing: (event: React.MouseEvent) => void;
  readonly pinging?: boolean | undefined;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-all duration-150 hover:bg-muted hover:text-foreground active:scale-95",
        pinging && "animate-pulse text-amber-500",
        className,
      )}
      onClick={onPing}
      onPointerDown={(event) => event.stopPropagation()}
      disabled={pinging}
      title="Ask Hermes what's up with this card"
      aria-label="Ping Hermes about this card"
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
    </button>
  );
}

function cardShellClassName(input: {
  readonly dragging: boolean;
  readonly working: boolean;
  readonly extra?: string | undefined;
}): string {
  return cn(
    // `touch-manipulation`, not `touch-none`: the drag sensor claims the
    // gesture only after a hold, and `none` handed every finger to dnd —
    // a column of cards could not be scrolled past on a phone.
    "relative cursor-grab touch-manipulation bg-raised text-card-foreground transition-colors active:cursor-grabbing",
    "hover:bg-accent",
    input.dragging && "opacity-70 shadow-panel ring-1 ring-primary/40",
    input.working && "ring-1 ring-amber-500/40",
    input.extra,
  );
}

export interface CardTileViewProps {
  readonly headline: string;
  /** Draft with nothing written yet — the headline renders as a hint. */
  readonly placeholder?: boolean | undefined;
  readonly projectLabel?: string | null | undefined;
  /** Provider + model, top-right. */
  readonly modelLabel?: string | null | undefined;
  /** Amber ring: Hermes is mid-write on this card, so it cannot be dragged. */
  readonly working?: boolean | undefined;
  /** The card's only status line. Never rendered beside another one. */
  readonly queueState?: CardQueueState | null | undefined;
  /** How long the card has been in this column, e.g. "12m". */
  readonly timeInColumn?: string | null | undefined;
  /** Tick-log id of the rule that made the card's last column move. */
  readonly ruleMove?: string | null | undefined;
  readonly prChecks?: PrCheckBadge | null | undefined;
  readonly prChecksUrl?: string | null | undefined;
  readonly prUrl?: string | null | undefined;
  /** Rendered as the `#1450` badge that links to the forge. */
  readonly prNumber?: number | null | undefined;
  /** Present only when there is a running turn to interrupt. */
  readonly onStop?: ((event: React.MouseEvent) => void) | null | undefined;
  /** The bell: asks Hermes where this card stands. Absent on a card it cannot name. */
  readonly onPing?: ((event: React.MouseEvent) => void) | null | undefined;
  /** That ping is in flight. */
  readonly pinging?: boolean | undefined;
  readonly dragging?: boolean | undefined;
  /** Fixed width, for a gallery that is not inside a column. */
  readonly width?: number | null | undefined;
  readonly containerRef?: React.Ref<HTMLDivElement> | undefined;
  /** Drag listeners and click handling. Spread first so the caller wins. */
  readonly containerProps?: React.HTMLAttributes<HTMLDivElement> | undefined;
  readonly style?: React.CSSProperties | undefined;
}

export function CardTileView({
  headline,
  placeholder = false,
  projectLabel,
  modelLabel,
  working = false,
  queueState,
  timeInColumn,
  ruleMove,
  prChecks,
  prChecksUrl,
  prUrl,
  prNumber,
  onStop,
  onPing,
  pinging,
  dragging = false,
  width,
  containerRef,
  containerProps,
  style,
}: CardTileViewProps) {
  return (
    <div
      ref={containerRef}
      {...containerProps}
      className={cardShellClassName({
        dragging,
        working,
        extra: cn("rounded-lg p-3", containerProps?.className),
      })}
      style={width ? { ...style, width } : style}
    >
      {modelLabel ? (
        <div
          className="absolute top-2 right-2 max-w-[45%] truncate text-[9px] font-medium text-muted-foreground/70"
          title={modelLabel}
        >
          {modelLabel}
        </div>
      ) : null}
      {queueState ? (
        <div className={cn("mb-1.5", modelLabel && "pr-[45%]")}>
          <QueueBadge state={queueState} />
        </div>
      ) : null}
      {projectLabel ? (
        <div className="mb-1 truncate text-[10px] font-medium text-muted-foreground">
          {projectLabel}
        </div>
      ) : null}
      <p
        className={cn(
          "line-clamp-3 text-[13px] font-medium leading-snug",
          placeholder ? "text-muted-foreground/50 italic" : "text-foreground",
        )}
      >
        {headline}
      </p>
      <div className="mt-1.5 flex min-h-6 items-center gap-2">
        {timeInColumn ? (
          <span
            className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
            title="Time in this column"
          >
            {timeInColumn}
          </span>
        ) : null}
        {ruleMove ? <RuleMoveBadge rule={ruleMove} /> : null}
        {prChecks ? <PrChecksBadge badge={prChecks} url={prChecksUrl} /> : null}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {prNumber !== null && prNumber !== undefined ? (
            <PrNumberBadge number={prNumber} url={prUrl} />
          ) : null}
          {onPing ? <PingButton onPing={onPing} pinging={pinging} /> : null}
          {onStop ? <StopButton onStop={onStop} /> : null}
        </div>
      </div>
    </div>
  );
}

const COMPACT_DOT_CLASS: Record<CardQueueState["tone"], string> = {
  running: "bg-amber-500",
  queued: "bg-sky-500",
  idle: "bg-muted-foreground/40",
  blocked: "bg-rose-500",
  applied: "bg-emerald-500",
};

/**
 * One line per card: a status dot, the headline, and the two numbers worth a
 * glance. For a column you are watching the shape of rather than reading —
 * five of these fit where two tiles did.
 */
export function CardTileCompactView({
  headline,
  placeholder = false,
  working = false,
  queueState,
  timeInColumn,
  prChecks,
  prUrl,
  prNumber,
  onStop,
  onPing,
  pinging,
  dragging = false,
  width,
  containerRef,
  containerProps,
  style,
}: CardTileViewProps) {
  return (
    <div
      ref={containerRef}
      {...containerProps}
      className={cardShellClassName({
        dragging,
        working,
        extra: cn("flex items-center gap-2 rounded-lg px-2.5 py-1.5", containerProps?.className),
      })}
      style={width ? { ...style, width } : style}
    >
      <span
        title={queueState?.title ?? undefined}
        className={cn(
          "size-2 shrink-0 rounded-full",
          queueState ? COMPACT_DOT_CLASS[queueState.tone] : "bg-border",
          queueState?.pulse === true && "animate-pulse",
        )}
      />
      <span
        title={headline}
        className={cn(
          "min-w-0 flex-1 truncate text-[12px] font-medium leading-snug",
          placeholder ? "text-muted-foreground/50 italic" : "text-foreground",
        )}
      >
        {headline}
      </span>
      {prChecks ? (
        <span
          title={prChecks.title}
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            prChecks.tone === "passed"
              ? "bg-emerald-500"
              : prChecks.tone === "failed"
                ? "bg-rose-500"
                : "bg-amber-500",
            prChecks.pulse && "animate-pulse",
          )}
        />
      ) : null}
      {timeInColumn ? (
        <span
          className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
          title="Time in this column"
        >
          {timeInColumn}
        </span>
      ) : null}
      {prNumber !== null && prNumber !== undefined ? (
        <PrNumberBadge number={prNumber} url={prUrl} className="shrink-0" />
      ) : null}
      {onPing ? <PingButton onPing={onPing} pinging={pinging} className="size-5" /> : null}
      {onStop ? <StopButton onStop={onStop} className="size-5" /> : null}
    </div>
  );
}

/**
 * Everything the card knows, spelled out: the headline unclipped, the project
 * and model on their own labelled lines, every badge in a row you can read
 * instead of decode. For the column you are actually working in.
 */
export function CardTileDetailedView({
  headline,
  placeholder = false,
  projectLabel,
  modelLabel,
  working = false,
  queueState,
  timeInColumn,
  ruleMove,
  prChecks,
  prChecksUrl,
  prUrl,
  prNumber,
  onStop,
  onPing,
  pinging,
  dragging = false,
  width,
  containerRef,
  containerProps,
  style,
}: CardTileViewProps) {
  return (
    <div
      ref={containerRef}
      {...containerProps}
      className={cardShellClassName({
        dragging,
        working,
        extra: cn("rounded-lg p-3", containerProps?.className),
      })}
      style={width ? { ...style, width } : style}
    >
      <p
        className={cn(
          "text-[13px] font-medium leading-snug",
          placeholder ? "text-muted-foreground/50 italic" : "text-foreground",
        )}
      >
        {headline}
      </p>
      <dl className="mt-2 space-y-0.5 text-[10px] text-muted-foreground">
        {projectLabel ? (
          <div className="flex gap-1.5">
            <dt className="w-12 shrink-0 text-muted-foreground/60">project</dt>
            <dd className="min-w-0 truncate font-medium text-foreground/80">{projectLabel}</dd>
          </div>
        ) : null}
        {modelLabel ? (
          <div className="flex gap-1.5">
            <dt className="w-12 shrink-0 text-muted-foreground/60">model</dt>
            <dd className="min-w-0 truncate">{modelLabel}</dd>
          </div>
        ) : null}
        {timeInColumn ? (
          <div className="flex gap-1.5">
            <dt className="w-12 shrink-0 text-muted-foreground/60">here</dt>
            <dd className="tabular-nums">{timeInColumn}</dd>
          </div>
        ) : null}
        {prNumber !== null && prNumber !== undefined ? (
          <div className="flex gap-1.5">
            <dt className="w-12 shrink-0 text-muted-foreground/60">pull</dt>
            <dd>
              <PrNumberBadge number={prNumber} url={prUrl} />
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {queueState ? <QueueBadge state={queueState} /> : null}
        {prChecks ? <PrChecksBadge badge={prChecks} url={prChecksUrl} /> : null}
        {ruleMove ? <RuleMoveBadge rule={ruleMove} /> : null}
        {onPing ? <PingButton onPing={onPing} pinging={pinging} className="ml-auto" /> : null}
        {onStop ? <StopButton onStop={onStop} className={cn(!onPing && "ml-auto")} /> : null}
      </div>
    </div>
  );
}

/**
 * The faces this build can draw, by the name a `display` row asks for.
 *
 * Open on purpose: a new face is an entry here and a component above it. The
 * dialog lists the keys, so registering one is the whole change.
 */
export const CARD_VIEWS: Record<string, (props: CardTileViewProps) => React.JSX.Element> = {
  default: CardTileView,
  compact: CardTileCompactView,
  detailed: CardTileDetailedView,
};

/** What each face is called where a person picks one. */
export const CARD_VIEW_LABELS: Record<string, string> = {
  default: "the board tile",
  compact: "one compact line",
  detailed: "the detailed card",
};

/**
 * A card drawn with the face its column asks for. The board mounts this, never
 * a face directly, so a `display` rule row is the only thing that decides.
 */
export function CardView({
  renderer = "default",
  ...props
}: CardTileViewProps & { readonly renderer?: CardRenderer | undefined }) {
  // A name nothing is registered under is a face this build cannot draw, so it
  // draws the tile. The row that asked for it stays in settings.
  const View = CARD_VIEWS[renderer] ?? CardTileView;
  return <View {...props} />;
}
