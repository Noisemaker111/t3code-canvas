import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

/**
 * Driver kinds registered by the product plus the vendor aliases that show up
 * in harness/usage code. Matching is exact and case-sensitive.
 */
const PROVIDER_NAMES = new Set([
  "claude",
  "claudeAgent",
  "claude-agent",
  "codex",
  "copilot",
  "cursor",
  "cursor-agent",
  "gemini",
  "ghostDriver",
  "githubCopilot",
  "grok",
  "ollama",
  "opencode",
  "openrouter",
  "piAgent",
  "x-ai",
  "xai",
]);

/** Files that own provider vocabulary. */
const CANONICAL_FILES = ["packages/contracts/src/providerInstance.ts"];

/**
 * Declarations that predate this rule. They are debt, not precedent: migrate
 * them to `ProviderInstanceId` rather than adding entries here.
 */
const LEGACY_DECLARATIONS = new Set([
  "HermesTier",
  "TelemetryIdentityDecodeError",
  "TextGenerationProvider",
  "UsageProviderId",
]);

const MESSAGE =
  "Ad-hoc provider vocabulary: this declares a new closed union of provider names. Route on ProviderInstanceId / ProviderDriverKind (packages/contracts/src/providerInstance.ts) instead of inventing a parallel list.";

const isCanonicalFile = (filename: string): boolean => {
  const normalized = filename.replaceAll("\\", "/");
  return CANONICAL_FILES.some((suffix) => normalized.endsWith(suffix));
};

const stringLiteralValue = (node: unknown): Option.Option<string> =>
  Option.flatMap(unwrapExpression(node), (expression) =>
    expression.type === "Literal" && typeof expression.value === "string"
      ? Option.some(expression.value)
      : Option.none(),
  );

const isProviderUnion = (literals: ReadonlyArray<string>, total: number): boolean =>
  literals.length === total &&
  literals.length >= 2 &&
  literals.every((literal) => PROVIDER_NAMES.has(literal));

const schemaLiteralsMethod = (callee: unknown): Option.Option<string> => {
  const expression = unwrapExpression(callee);
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") {
    return Option.none();
  }
  if (!isIdentifier(unwrapExpression(expression.value.object), "Schema")) return Option.none();

  return Option.filter(
    getPropertyName(expression.value.property),
    (method) => method === "Literal" || method === "Literals",
  );
};

const arrayLiterals = (node: unknown): Option.Option<ReadonlyArray<string>> =>
  Option.flatMap(unwrapExpression(node), (expression) => {
    if (expression.type !== "ArrayExpression") return Option.none();
    const values = expression.elements.flatMap((element) =>
      Option.toArray(stringLiteralValue(element)),
    );
    return values.length === expression.elements.length ? Option.some(values) : Option.none();
  });

const enclosingDeclarationName = (node: unknown): Option.Option<string> => {
  let current: unknown = node;
  for (let depth = 0; depth < 32; depth++) {
    if (typeof current !== "object" || current === null || !("type" in current)) break;
    const candidate = current as { readonly type: string; readonly id?: unknown };
    if (
      candidate.type === "VariableDeclarator" ||
      candidate.type === "TSTypeAliasDeclaration" ||
      candidate.type === "ClassDeclaration" ||
      candidate.type === "ClassExpression" ||
      candidate.type === "TSInterfaceDeclaration"
    ) {
      const name = getPropertyName(candidate.id);
      if (Option.isSome(name)) return name;
    }
    current = "parent" in candidate ? candidate.parent : undefined;
  }
  return Option.none();
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow declaring a new string-literal union of provider/driver names outside the canonical provider-instance contracts.",
    },
  },
  create(context) {
    if (TEST_FILE_PATTERN.test(context.filename)) return {};
    if (isCanonicalFile(context.filename)) return {};

    const constArrays = new Map<string, ReadonlyArray<string>>();
    const pending: Array<{ readonly node: unknown; readonly identifier?: string }> = [];

    const queue = (node: unknown, literals: ReadonlyArray<string>, total: number) => {
      if (isProviderUnion(literals, total)) pending.push({ node });
    };

    return {
      VariableDeclarator(node) {
        const name = getPropertyName(node.id);
        const values = arrayLiterals(node.init);
        if (Option.isSome(name) && Option.isSome(values)) {
          constArrays.set(name.value, values.value);
        }
      },
      TSUnionType(node) {
        const literals = node.types.flatMap((member) =>
          member.type === "TSLiteralType" ? Option.toArray(stringLiteralValue(member.literal)) : [],
        );
        queue(node, literals, node.types.length);
      },
      CallExpression(node) {
        if (Option.isNone(schemaLiteralsMethod(node.callee))) return;

        const [first] = node.arguments;
        const fromArray = arrayLiterals(first);
        if (Option.isSome(fromArray)) {
          queue(node, fromArray.value, fromArray.value.length);
          return;
        }

        const identifier = unwrapExpression(first);
        if (
          node.arguments.length === 1 &&
          Option.isSome(identifier) &&
          identifier.value.type === "Identifier"
        ) {
          pending.push({ node, identifier: identifier.value.name });
          return;
        }

        const literals = node.arguments.flatMap((argument) =>
          Option.toArray(stringLiteralValue(argument)),
        );
        queue(node, literals, node.arguments.length);
      },
      "Program:exit"() {
        for (const entry of pending) {
          if (entry.identifier !== undefined) {
            const values = constArrays.get(entry.identifier);
            if (!values || !isProviderUnion(values, values.length)) continue;
          }
          const declaration = enclosingDeclarationName(entry.node);
          if (Option.isSome(declaration) && LEGACY_DECLARATIONS.has(declaration.value)) continue;
          context.report({ node: entry.node as never, message: MESSAGE });
        }
      },
    };
  },
});
