/**
 * tldraw is proprietary: the SDK blanks the editor five seconds after an
 * expired or production-unlicensed load ({@link https://github.com/tldraw/tldraw/blob/main/LICENSE.md}),
 * and the whole app lives on that canvas — so an unattended key expiry takes
 * the entire board down, not just drawing. The key is therefore settable from
 * Settings → Board and its expiry is read here, so the operator is told before
 * the SDK decides to show them nothing.
 */

/** Days before expiry at which the board starts warning. */
export const EXPIRY_WARNING_DAYS = 21;

export type TldrawLicense =
  | { readonly kind: "missing" }
  | { readonly kind: "unparseable"; readonly key: string }
  | { readonly kind: "ok"; readonly key: string; readonly expiresOn: string }
  | {
      readonly kind: "expiring";
      readonly key: string;
      readonly expiresOn: string;
      readonly daysLeft: number;
    }
  | { readonly kind: "expired"; readonly key: string; readonly expiresOn: string };

const KEY_PREFIX = /^tldraw-(\d{4})-(\d{2})-(\d{2})\//;

const MS_PER_DAY = 86_400_000;

/**
 * tldraw stamps the expiry date into the key's own prefix, so the deadline is
 * readable without the SDK's internal license manager (which is `@internal` and
 * only reports state once the editor has already mounted).
 */
/**
 * Which key the canvas runs on: the one saved in settings, else the build-time
 * `VITE_TLDRAW_LICENSE_KEY` deploy baked in. Settings wins so a key can be
 * replaced from the board itself instead of a rebuild.
 */
export function resolveTldrawLicenseKey(input: {
  readonly settingsKey: string | undefined;
  readonly buildKey: string | undefined;
}): string | undefined {
  const settings = input.settingsKey?.trim();
  return settings ? settings : input.buildKey;
}

export function readTldrawLicense(rawKey: string | undefined, now: Date): TldrawLicense {
  const key = rawKey?.trim();
  if (!key) return { kind: "missing" };

  const match = KEY_PREFIX.exec(key);
  if (!match) return { kind: "unparseable", key };

  const [, year, month, day] = match;
  const expiresOn = `${year}-${month}-${day}`;
  const expiry = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysLeft = Math.round((expiry - today) / MS_PER_DAY);

  if (daysLeft < 0) return { kind: "expired", key, expiresOn };
  if (daysLeft <= EXPIRY_WARNING_DAYS) return { kind: "expiring", key, expiresOn, daysLeft };
  return { kind: "ok", key, expiresOn };
}

/**
 * The `licenseKey` prop to spread onto `<Tldraw>`, omitted entirely when there
 * is no key. An expired key is still passed through so tldraw prints its own
 * diagnostics alongside ours.
 */
export function licenseProps(license: TldrawLicense): { readonly licenseKey?: string } {
  return license.kind === "missing" ? {} : { licenseKey: license.key };
}

export function isLicenseHealthy(license: TldrawLicense): boolean {
  return license.kind === "ok";
}

export type TldrawLicenseNotice = {
  readonly tone: "warning" | "danger";
  readonly title: string;
  readonly detail: string;
};

/** Actionable copy for the canvas-level recovery banner. */
export function tldrawLicenseNotice(license: TldrawLicense): TldrawLicenseNotice | null {
  switch (license.kind) {
    case "ok":
      return null;
    case "expiring":
      return {
        tone: "warning",
        title: `Canvas licence expires in ${license.daysLeft} day${license.daysLeft === 1 ? "" : "s"}`,
        detail: "Replace the tldraw key now so the board does not disappear when it lapses.",
      };
    case "expired":
      return {
        tone: "danger",
        title: "Canvas licence expired",
        detail: `The tldraw key expired ${license.expiresOn}. Add a current key to keep the board open.`,
      };
    case "unparseable":
      return {
        tone: "danger",
        title: "Canvas licence is invalid",
        detail: "The saved value is not a tldraw key. Replace it with a key from tldraw.dev.",
      };
    case "missing":
      return {
        tone: "danger",
        title: "Canvas setup required",
        detail: "Add a tldraw licence key so this production board stays open.",
      };
  }
}
