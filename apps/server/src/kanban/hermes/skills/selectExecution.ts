import type { HermesRoutingSkill } from "./types.ts";

export const selectExecutionSkill: HermesRoutingSkill = {
  id: "select-execution",
  purpose: "Choose one exact route using semantic requirements and compact measured facts.",
  instructions: [
    "A pinnedRouteId is a human constraint: use it, and block when it is unavailable.",
    "Discard unavailable routes and every route outside a hard allowlist first.",
    "Balance benchmark capability, measured speed, expected usage, remaining capacity, reset timing and the owner's rule. Subscription capacity is percentages; USD is only for metered pools.",
    "Unknown evidence stays unknown: never infer capability or speed from price, route order, model name, prompt length or keywords.",
    "Spend premium capacity on risk; preserve scarce capacity when another route is clearly sufficient.",
    "Copy the route's fixed options exactly and choose every offered optionChoice; never invent one.",
  ],
};
