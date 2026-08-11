import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  bindFrictionLog,
  listFriction,
  recordFriction,
  unbindFrictionLog,
} from "../friction/frictionStore.ts";
import {
  appendHermesTick,
  bindHermesTickLog,
  readHermesTickLog,
  unbindHermesTickLog,
} from "../kanban/hermes/tickLogStore.ts";
import {
  appendHermesUsage,
  bindHermesUsageLog,
  readHermesUsageLog,
  unbindHermesUsageLog,
} from "../kanban/hermes/usageLogStore.ts";
import {
  checkPurgeConfirmation,
  isMaintenanceTargetId,
  purgeMaintenanceTarget,
  surveyMaintenanceTarget,
  MAINTENANCE_TARGET_IDS,
} from "./Maintenance.ts";

/**
 * A fresh `:memory:` database per test. A shared `it.layer` would let one test's
 * seed rows decide another test's counts, which is exactly what these assertions
 * are about.
 */
const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(
    Effect.provide(
      SqlitePersistenceMemory.pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-maintenance-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.orDie,
  );

function tempBaseDir(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-maintenance-"));
}

const seedThread = (input: {
  readonly threadId: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
         created_at, updated_at, archived_at, deleted_at)
      VALUES
        (${input.threadId}, 'project-1', ${input.threadId}, '{}', 'local', 'interactive',
         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ${input.archivedAt}, ${input.deletedAt})
    `;
    yield* sql`
      INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES
        (${`${input.threadId}-m1`}, ${input.threadId}, 'user', 'hello', 0,
         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `;
    yield* sql`
      INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
         actor_kind, payload_json, metadata_json)
      VALUES
        (${`${input.threadId}-e1`}, 'thread', ${input.threadId}, 1, 'ThreadCreated',
         '2026-01-01T00:00:00Z', 'user', '{}', '{}')
    `;
  });

const seedCard = (input: { readonly id: string; readonly archivedAt: string | null }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO kanban_cards
        (id, title, body, column_id, position, created_at, updated_at, archived_at)
      VALUES
        (${input.id}, ${input.id}, '', 'prompts', 1, '2026-01-01T00:00:00Z',
         '2026-01-01T00:00:00Z', ${input.archivedAt})
    `;
  });

const seedCanvas = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO canvas_documents (doc_id, snapshot_json, revision, created_at, updated_at)
    VALUES ('board', '{"shapes":[]}', 3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `;
  yield* sql`
    INSERT INTO canvas_injections (id, doc_id, spec_json, created_at)
    VALUES ('inj-1', 'board', '{}', '2026-01-01T00:00:00Z')
  `;
  yield* sql`
    INSERT INTO canvas_messages
      (id, doc_id, author_kind, text, target, created_at)
    VALUES ('msg-1', 'board', 'human', 'look at this', 'hermes', '2026-01-01T00:00:00Z')
  `;
  yield* sql`
    INSERT INTO canvas_messages
      (id, doc_id, author_kind, text, target, created_at)
    VALUES ('msg-2', 'board', 'human', 'and this', 'hermes', '2026-01-01T00:00:00Z')
  `;
});

const countRows = (from: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT COUNT(*) AS n FROM ${sql.unsafe(from)}`;
    return (rows[0] as { n: number }).n;
  });

describe("maintenance confirmation gating", () => {
  const survey = {
    target: "friction",
    title: "Friction log",
    summary: "",
    items: 7,
    bytes: 0,
    lines: [],
    requiresPhrase: null,
  } as const;

  it("refuses a purge whose confirmed count no longer matches the survey", () => {
    const gate = checkPurgeConfirmation({
      target: "friction",
      confirmItems: 6,
      confirmPhrase: undefined,
      survey,
    });
    assert.equal(gate.ok, false);
    if (gate.ok) return;
    assert.equal(gate.status, 409);
    assert.include(gate.error, "7");
  });

  it("refuses a purge with no confirmed count at all", () => {
    const gate = checkPurgeConfirmation({
      target: "friction",
      confirmItems: undefined,
      confirmPhrase: undefined,
      survey,
    });
    assert.equal(gate.ok, false);
    if (gate.ok) return;
    assert.equal(gate.status, 400);
  });

  it("accepts a purge that echoes the surveyed count", () => {
    const gate = checkPurgeConfirmation({
      target: "friction",
      confirmItems: 7,
      confirmPhrase: undefined,
      survey,
    });
    assert.equal(gate.ok, true);
  });

  it("refuses an empty purge so a no-op never reads as a deletion", () => {
    const gate = checkPurgeConfirmation({
      target: "friction",
      confirmItems: 0,
      confirmPhrase: undefined,
      survey: { ...survey, items: 0 },
    });
    assert.equal(gate.ok, false);
  });

  it("refuses a canvas wipe without the typed phrase, count alone is not enough", () => {
    const canvasSurvey = { ...survey, target: "canvas", requiresPhrase: "wipe canvas" } as const;
    const noPhrase = checkPurgeConfirmation({
      target: "canvas",
      confirmItems: 7,
      confirmPhrase: undefined,
      survey: canvasSurvey,
    });
    assert.equal(noPhrase.ok, false);
    if (noPhrase.ok) return;
    assert.equal(noPhrase.status, 400);

    const wrongPhrase = checkPurgeConfirmation({
      target: "canvas",
      confirmItems: 7,
      confirmPhrase: "yes",
      survey: canvasSurvey,
    });
    assert.equal(wrongPhrase.ok, false);

    const typed = checkPurgeConfirmation({
      target: "canvas",
      confirmItems: 7,
      confirmPhrase: "  Wipe Canvas ",
      survey: canvasSurvey,
    });
    assert.equal(typed.ok, true);
  });

  it("only the canvas target demands a phrase", () => {
    for (const target of MAINTENANCE_TARGET_IDS) {
      const gate = checkPurgeConfirmation({
        target,
        confirmItems: 7,
        confirmPhrase: undefined,
        survey: { ...survey, target },
      });
      assert.equal(gate.ok, target !== "canvas", target);
    }
  });

  it("rejects an unknown target", () => {
    assert.equal(isMaintenanceTargetId("canvas"), true);
    assert.equal(isMaintenanceTargetId("everything"), false);
    assert.equal(isMaintenanceTargetId(null), false);
  });
});

describe("maintenance file-backed purges", () => {
  it.effect("clears the friction log and reports how many entries went", () =>
    withDb(
      Effect.gen(function* () {
        const baseDir = tempBaseDir();
        bindFrictionLog(baseDir);
        try {
          recordFriction({ source: "agent", scope: "harness", tool: "apply_patch", summary: "a" });
          recordFriction({ source: "agent", scope: "repo", tool: "pnpm", summary: "b" });
          assert.equal(listFriction().length, 2);

          const purged = yield* purgeMaintenanceTarget("friction");
          assert.equal(purged.items, 2);
          assert.equal(listFriction().length, 0);

          bindFrictionLog(baseDir);
          assert.equal(listFriction().length, 0);
        } finally {
          unbindFrictionLog();
          NodeFS.rmSync(baseDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("clears Hermes tick and usage logs together and leaves neither on disk", () =>
    withDb(
      Effect.gen(function* () {
        const baseDir = tempBaseDir();
        bindHermesTickLog(baseDir);
        bindHermesUsageLog(baseDir);
        try {
          appendHermesTick(
            {
              id: "tick-1",
              ranAt: "2026-01-01T00:00:00Z",
              tier: null,
              model: "grok",
              durationMs: 1,
              program: null,
              calls: [],
              logs: [],
              error: null,
            } as never,
            30,
          );
          appendHermesUsage({
            id: "tick-1",
            ranAt: "2026-01-01T00:00:00Z",
            tier: null,
            model: "grok",
            trigger: "interval",
            durationMs: 1,
            modelMs: 0,
            executionMs: 0,
            modelCalls: 0,
            promptChars: 0,
            snapshotChars: 0,
            programChars: 0,
            calls: 0,
            writes: 0,
            ruleActions: 0,
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
            usd: null,
            provider: null,
            failed: false,
          });
          assert.equal(readHermesTickLog(30).length, 1);
          assert.equal(readHermesUsageLog(30).length, 1);

          const purged = yield* purgeMaintenanceTarget("hermes-logs");
          assert.equal(purged.items, 2);
          assert.equal(readHermesTickLog(30).length, 0);
          assert.equal(readHermesUsageLog(30).length, 0);
        } finally {
          unbindHermesTickLog();
          unbindHermesUsageLog();
          NodeFS.rmSync(baseDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("surveys the friction log without deleting anything", () =>
    withDb(
      Effect.gen(function* () {
        const baseDir = tempBaseDir();
        bindFrictionLog(baseDir);
        try {
          recordFriction({ source: "agent", scope: "harness", tool: "apply_patch", summary: "a" });
          const survey = yield* surveyMaintenanceTarget("friction");
          assert.equal(survey.items, 1);
          assert.equal(listFriction().length, 1);
        } finally {
          unbindFrictionLog();
          NodeFS.rmSync(baseDir, { recursive: true, force: true });
        }
      }),
    ),
  );
});

describe("maintenance archived purge", () => {
  it.effect("deletes archived and soft-deleted threads and leaves live ones whole", () =>
    withDb(
      Effect.gen(function* () {
        yield* seedThread({ threadId: "live", archivedAt: null, deletedAt: null });
        yield* seedThread({
          threadId: "archived",
          archivedAt: "2026-01-02T00:00:00Z",
          deletedAt: null,
        });
        yield* seedThread({
          threadId: "deleted",
          archivedAt: null,
          deletedAt: "2026-01-02T00:00:00Z",
        });
        yield* seedCard({ id: "live-card", archivedAt: null });
        yield* seedCard({ id: "archived-card", archivedAt: "2026-01-02T00:00:00Z" });

        const survey = yield* surveyMaintenanceTarget("archived");
        assert.equal(survey.items, 3, "2 dead threads + 1 archived card");

        const result = yield* purgeMaintenanceTarget("archived");
        assert.equal(result.items, 3);

        assert.equal(yield* countRows("projection_threads"), 1);
        assert.equal(yield* countRows("projection_threads WHERE thread_id = 'live'"), 1);
        assert.equal(yield* countRows("projection_thread_messages"), 1);
        assert.equal(yield* countRows("projection_thread_messages WHERE thread_id = 'live'"), 1);
        assert.equal(yield* countRows("orchestration_events"), 1);
        assert.equal(yield* countRows("orchestration_events WHERE stream_id = 'live'"), 1);
        assert.equal(yield* countRows("kanban_cards"), 1);
        assert.equal(yield* countRows("kanban_cards WHERE id = 'live-card'"), 1);
      }),
    ),
  );

  it.effect("purging archived history never touches the canvas", () =>
    withDb(
      Effect.gen(function* () {
        yield* seedThread({
          threadId: "archived",
          archivedAt: "2026-01-02T00:00:00Z",
          deletedAt: null,
        });
        yield* seedCanvas;

        yield* purgeMaintenanceTarget("archived");

        assert.equal(yield* countRows("canvas_documents"), 1);
        assert.equal(yield* countRows("canvas_injections"), 1);
        assert.equal(yield* countRows("canvas_messages"), 2);
      }),
    ),
  );
});

describe("maintenance canvas purges", () => {
  it.effect("wiping the canvas drops the document, queue and messages and nothing else", () =>
    withDb(
      Effect.gen(function* () {
        yield* seedThread({ threadId: "live", archivedAt: null, deletedAt: null });
        yield* seedCard({ id: "live-card", archivedAt: null });
        yield* seedCanvas;

        const survey = yield* surveyMaintenanceTarget("canvas");
        assert.equal(survey.items, 4, "1 document + 1 injection + 2 messages");
        assert.equal(survey.requiresPhrase, "wipe canvas");

        yield* purgeMaintenanceTarget("canvas");

        assert.equal(yield* countRows("canvas_documents"), 0);
        assert.equal(yield* countRows("canvas_injections"), 0);
        assert.equal(yield* countRows("canvas_messages"), 0);
        assert.equal(yield* countRows("projection_threads"), 1);
        assert.equal(yield* countRows("kanban_cards"), 1);
      }),
    ),
  );

  it.effect("every other purge leaves the canvas document byte-for-byte alone", () =>
    withDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedCanvas;
        yield* seedThread({
          threadId: "archived",
          archivedAt: "2026-01-02T00:00:00Z",
          deletedAt: null,
        });

        for (const target of ["friction", "hermes-logs", "archived"] as const) {
          yield* purgeMaintenanceTarget(target);
        }

        const rows =
          yield* sql`SELECT snapshot_json AS s FROM canvas_documents WHERE doc_id = 'board'`;
        assert.equal((rows[0] as { s: string }).s, '{"shapes":[]}');
      }),
    ),
  );
});
