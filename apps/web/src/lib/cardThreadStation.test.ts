import { describe, expect, it } from "vite-plus/test";

import { cardThreadStationSearch } from "./cardThreadStation";

describe("cardThreadStationSearch", () => {
  it("binds only the card thread id", () => {
    expect(cardThreadStationSearch("b7841e1b-ff86-4f34-a254-5c441b902fd5")).toEqual({
      station: "thread:b7841e1b-ff86-4f34-a254-5c441b902fd5",
    });
  });

  it("returns null when the card has no thread", () => {
    expect(cardThreadStationSearch(null)).toBeNull();
    expect(cardThreadStationSearch("")).toBeNull();
    expect(cardThreadStationSearch("   ")).toBeNull();
  });
});
