import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerNeedsLogin } from "./providerStatus";

type ProviderLoginState = Pick<ServerProvider, "installed" | "auth">;

function provider(
  installed: boolean,
  status: ProviderLoginState["auth"]["status"],
): ProviderLoginState {
  return { installed, auth: { status } };
}

describe("providerNeedsLogin", () => {
  it("offers login for installed providers until authentication is confirmed", () => {
    expect(providerNeedsLogin(provider(true, "unauthenticated"))).toBe(true);
    expect(providerNeedsLogin(provider(true, "unknown"))).toBe(true);
    expect(providerNeedsLogin(provider(true, "authenticated"))).toBe(false);
  });

  it("waits for installation and a live provider snapshot", () => {
    expect(providerNeedsLogin(provider(false, "unauthenticated"))).toBe(false);
    expect(providerNeedsLogin(undefined)).toBe(false);
  });
});
