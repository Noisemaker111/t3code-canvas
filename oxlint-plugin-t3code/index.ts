import { definePlugin } from "@oxlint/plugins";

import namespaceNodeImports from "./rules/namespace-node-imports.ts";
import noAdhocProviderUnion from "./rules/no-adhoc-provider-union.ts";
import noEffectPromiseOnFallible from "./rules/no-effect-promise-on-fallible.ts";
import noEffectRunOutsideEntrypoint from "./rules/no-effect-run-outside-entrypoint.ts";
import noGlobalProcessRuntime from "./rules/no-global-process-runtime.ts";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noJsonParseCast from "./rules/no-json-parse-cast.ts";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.ts";
import noRawModelPicker from "./rules/no-raw-model-picker.ts";
import noRawPromiseInEffectModule from "./rules/no-raw-promise-in-effect-module.ts";
import noSilentCatchDefault from "./rules/no-silent-catch-default.ts";

export default definePlugin({
  meta: {
    name: "t3code",
  },
  rules: {
    "namespace-node-imports": namespaceNodeImports,
    "no-adhoc-provider-union": noAdhocProviderUnion,
    "no-effect-promise-on-fallible": noEffectPromiseOnFallible,
    "no-effect-run-outside-entrypoint": noEffectRunOutsideEntrypoint,
    "no-global-process-runtime": noGlobalProcessRuntime,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-json-parse-cast": noJsonParseCast,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
    "no-raw-model-picker": noRawModelPicker,
    "no-raw-promise-in-effect-module": noRawPromiseInEffectModule,
    "no-silent-catch-default": noSilentCatchDefault,
  },
});
