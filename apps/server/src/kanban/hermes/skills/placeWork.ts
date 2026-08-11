import type { HermesRoutingSkill } from "./types.ts";

export const placeWorkSkill: HermesRoutingSkill = {
  id: "place-work",
  purpose: "Choose a new isolated thread or a compatible relevant thread.",
  instructions: [
    "Reuse only the source card's own thread, and only when the brief has it, it concerns this exact work and it fits the selected route.",
    "Prefer new isolation for unrelated work, risky work, or a context-heavy thread.",
    "Never name a thread the runtime cannot apply.",
  ],
};
