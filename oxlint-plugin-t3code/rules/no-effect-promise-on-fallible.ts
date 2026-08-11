import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const SAFE_NAME_PATTERN = /Safe$/u;

const MESSAGE =
  "Effect.promise turns rejection into a defect. If this thunk can reject (fs, network, subprocess, anything that throws), use Effect.tryPromise with a typed error; Effect.promise is only for promises that cannot fail.";

const calleeName = (callee: unknown): Option.Option<string> => {
  const unwrapped = unwrapExpression(callee);
  if (Option.isNone(unwrapped)) return Option.none();
  if (unwrapped.value.type === "Identifier") return Option.some(unwrapped.value.name);
  if (unwrapped.value.type === "MemberExpression") {
    return getPropertyName(unwrapped.value.property);
  }
  return Option.none();
};

const isInfallibleShape = (body: unknown): boolean => {
  const expression = unwrapExpression(body);
  if (Option.isNone(expression)) return false;
  const node = expression.value;

  if (node.type === "ImportExpression") return true;
  if (node.type !== "CallExpression") return false;

  const name = calleeName(node.callee);
  if (Option.isSome(name) && SAFE_NAME_PATTERN.test(name.value)) return true;

  const callee = unwrapExpression(node.callee);
  if (Option.isSome(callee) && callee.value.type === "MemberExpression") {
    const property = getPropertyName(callee.value.property);
    if (Option.isSome(property)) {
      if (property.value === "catch") return true;
      if (property.value === "then" && node.arguments.length === 2) return true;
    }
  }
  return false;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Warn when Effect.promise wraps a thunk that looks fallible; rejection becomes an untyped defect.",
    },
  },
  create(context) {
    if (TEST_FILE_PATTERN.test(context.filename)) return {};

    return {
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return;
        if (!isIdentifier(unwrapExpression(callee.value.object), "Effect")) return;

        const property = getPropertyName(callee.value.property);
        if (Option.isNone(property) || property.value !== "promise") return;

        const thunk = node.arguments[0] as
          | { readonly type?: string; readonly body?: unknown }
          | undefined;
        if (thunk?.type !== "ArrowFunctionExpression") return;
        if (isInfallibleShape(thunk.body)) return;

        context.report({ node: node.callee, message: MESSAGE });
      },
    };
  },
});
