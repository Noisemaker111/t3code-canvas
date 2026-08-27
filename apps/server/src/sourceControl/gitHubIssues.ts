import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

export interface NormalizedGitHubIssueRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly labels: ReadonlyArray<string>;
}

const GitHubIssueSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  labels: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
        }),
      ),
    ),
  ),
});

function normalizeGitHubIssueRecord(
  raw: Schema.Schema.Type<typeof GitHubIssueSchema>,
): NormalizedGitHubIssueRecord {
  const labels: string[] = [];
  for (const label of raw.labels ?? []) {
    const name = label.name.trim();
    if (name.length > 0) labels.push(name);
  }
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state?.trim().toUpperCase() === "CLOSED" ? "closed" : "open",
    labels,
  };
}

const decodeGitHubIssueList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeGitHubIssueEntry = Schema.decodeUnknownExit(GitHubIssueSchema);

export function decodeGitHubIssueListJson(
  raw: string,
): Result.Result<ReadonlyArray<NormalizedGitHubIssueRecord>, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGitHubIssueList(raw);
  if (Result.isSuccess(result)) {
    const issues: NormalizedGitHubIssueRecord[] = [];
    for (const entry of result.success) {
      const decodedEntry = decodeGitHubIssueEntry(entry);
      if (Exit.isFailure(decodedEntry)) {
        continue;
      }
      issues.push(normalizeGitHubIssueRecord(decodedEntry.value));
    }
    return Result.succeed(issues);
  }
  return Result.fail(result.failure);
}
