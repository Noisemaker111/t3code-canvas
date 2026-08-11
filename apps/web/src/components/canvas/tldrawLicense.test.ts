import { describe, expect, it } from "vite-plus/test";

import {
  EXPIRY_WARNING_DAYS,
  licenseProps,
  readTldrawLicense,
  resolveTldrawLicenseKey,
  tldrawLicenseNotice,
} from "./tldrawLicense";

const key = (date: string) => `tldraw-${date}/WyJhYmMiLFsiKiJdLDgsIjIwMjYtMDEtMDEiXQ.sig`;

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("readTldrawLicense", () => {
  it("reports a missing key rather than guessing one", () => {
    expect(readTldrawLicense(undefined, at("2026-01-01"))).toEqual({ kind: "missing" });
    expect(readTldrawLicense("   ", at("2026-01-01"))).toEqual({ kind: "missing" });
  });

  it("flags a key whose prefix carries no expiry", () => {
    expect(readTldrawLicense("not-a-tldraw-key", at("2026-01-01"))).toEqual({
      kind: "unparseable",
      key: "not-a-tldraw-key",
    });
  });

  it("is healthy well before expiry", () => {
    const license = readTldrawLicense(key("2026-12-31"), at("2026-01-01"));
    expect(license).toMatchObject({ kind: "ok", expiresOn: "2026-12-31" });
  });

  it("warns inside the expiry window", () => {
    const license = readTldrawLicense(key("2026-08-12"), at("2026-08-01"));
    expect(license).toMatchObject({ kind: "expiring", expiresOn: "2026-08-12", daysLeft: 11 });
  });

  it("treats the boundary day as still warning, not yet expired", () => {
    const license = readTldrawLicense(key("2026-08-22"), at("2026-08-01"));
    expect(license).toMatchObject({ kind: "expiring", daysLeft: EXPIRY_WARNING_DAYS });
  });

  it("counts expiry day itself as live", () => {
    expect(readTldrawLicense(key("2026-08-12"), at("2026-08-12"))).toMatchObject({
      kind: "expiring",
      daysLeft: 0,
    });
  });

  it("reports expiry the day after", () => {
    expect(readTldrawLicense(key("2026-08-12"), at("2026-08-13"))).toMatchObject({
      kind: "expired",
      expiresOn: "2026-08-12",
    });
  });
});

describe("resolveTldrawLicenseKey", () => {
  it("prefers the key saved in settings over the one baked into the build", () => {
    expect(resolveTldrawLicenseKey({ settingsKey: "saved", buildKey: "built" })).toBe("saved");
  });

  it("falls back to the build key when settings hold nothing", () => {
    expect(resolveTldrawLicenseKey({ settingsKey: "", buildKey: "built" })).toBe("built");
    expect(resolveTldrawLicenseKey({ settingsKey: "  ", buildKey: "built" })).toBe("built");
    expect(resolveTldrawLicenseKey({ settingsKey: undefined, buildKey: "built" })).toBe("built");
  });

  it("has nothing to resolve when neither is set", () => {
    expect(resolveTldrawLicenseKey({ settingsKey: "", buildKey: undefined })).toBeUndefined();
  });
});

describe("licenseProps", () => {
  it("hands an expired key to the SDK so tldraw can report it too", () => {
    const license = readTldrawLicense(key("2020-01-01"), at("2026-01-01"));
    expect(licenseProps(license)).toEqual({ licenseKey: key("2020-01-01") });
  });

  it("omits the prop entirely when there is no key", () => {
    expect(licenseProps({ kind: "missing" })).toEqual({});
  });
});

describe("tldrawLicenseNotice", () => {
  it("stays quiet for a healthy licence", () => {
    expect(tldrawLicenseNotice(readTldrawLicense(key("2027-12-31"), at("2026-01-01")))).toBeNull();
  });

  it("makes a missing production key directly actionable", () => {
    expect(tldrawLicenseNotice({ kind: "missing" })).toEqual({
      tone: "danger",
      title: "Canvas setup required",
      detail: "Add a tldraw licence key so this production board stays open.",
    });
  });

  it("warns before expiry without calling the key invalid", () => {
    expect(tldrawLicenseNotice(readTldrawLicense(key("2026-08-12"), at("2026-08-01")))).toEqual({
      tone: "warning",
      title: "Canvas licence expires in 11 days",
      detail: "Replace the tldraw key now so the board does not disappear when it lapses.",
    });
  });
});
