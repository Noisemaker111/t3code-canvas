/**
 * Chromium executable resolution for the server-hosted agent browser.
 *
 * Resolution order: T3CODE_BROWSER_EXECUTABLE, then PLAYWRIGHT_BROWSERS_PATH,
 * then zero-config probing of the well-known install locations (the VPS
 * browsers dir, Playwright's default cache, the system Chrome/Chromium). An
 * explicitly configured location that turns out empty is a loud error, never
 * a fall-through. No download is ever attempted — when nothing is found the
 * AgentBrowserUnavailableError lists every location probed
 * (deploy/ensure-browser.sh ships the binary on the VPS).
 */
import { AgentBrowserUnavailableError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** Locations probed when no browser env var is configured. */
export interface ChromiumProbeLocations {
  /** Directories shaped like PLAYWRIGHT_BROWSERS_PATH (chromium-* builds). */
  readonly browsersDirs: ReadonlyArray<string>;
  /** Direct Chromium/Chrome binary paths. */
  readonly executables: ReadonlyArray<string>;
}

/** The VPS install target plus each platform's stock browser locations. */
export function defaultChromiumProbeLocations(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ChromiumProbeLocations {
  const home = env.HOME?.trim();
  if (platform === "darwin") {
    return {
      browsersDirs: home ? [`${home}/Library/Caches/ms-playwright`] : [],
      executables: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ],
    };
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    const programFiles = env.PROGRAMFILES?.trim() ?? "C:\\Program Files";
    const programFilesX86 = env["PROGRAMFILES(X86)"]?.trim() ?? "C:\\Program Files (x86)";
    return {
      browsersDirs: localAppData ? [`${localAppData}\\ms-playwright`] : [],
      executables: [
        `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
        `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
        ...(localAppData ? [`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`] : []),
        `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ],
    };
  }
  return {
    browsersDirs: ["/opt/t3j/browsers", ...(home ? [`${home}/.cache/ms-playwright`] : [])],
    executables: [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
    ],
  };
}

const isFile = Effect.fn("AgentBrowserExecutable.isFile")(function* (candidate: string) {
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.stat(candidate).pipe(Effect.orElseSucceed(() => null));
  return stat !== null && stat.type === "File";
});

/** Newest chromium build binary under a PLAYWRIGHT_BROWSERS_PATH-shaped dir. */
const findInBrowsersDir = Effect.fn("AgentBrowserExecutable.findInBrowsersDir")(function* (
  browsersPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A dir that is absent or unreadable simply has no build to offer.
  const listing = yield* fs.readDirectory(browsersPath, { recursive: false }).pipe(Effect.option);
  if (Option.isNone(listing)) return null;
  const entries = listing.value;
  const builds = entries
    .filter((name) => /^chromium-\d+$/.test(name))
    .toSorted(
      (left, right) =>
        Number(right.slice("chromium-".length)) - Number(left.slice("chromium-".length)),
    );
  // Bare `chromium` symlinks (as provisioned by some sandboxes) are also accepted.
  const candidates = [...builds, ...entries.filter((name) => name === "chromium")];
  for (const build of candidates) {
    const buildDir = path.join(browsersPath, build);
    for (const relative of [
      "chrome-linux/chrome",
      "chrome-linux64/chrome",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      "chrome-win/chrome.exe",
      "chrome-win64/chrome.exe",
      "",
    ]) {
      const candidate = relative === "" ? buildDir : path.join(buildDir, relative);
      if (yield* isFile(candidate)) return candidate;
    }
  }
  return null;
});

export const resolveChromiumExecutable = Effect.fn("AgentBrowserExecutable.resolve")(function* (
  env: NodeJS.ProcessEnv,
  probe?: ChromiumProbeLocations,
): Effect.fn.Return<string, AgentBrowserUnavailableError, FileSystem.FileSystem | Path.Path> {
  const explicit = env.T3CODE_BROWSER_EXECUTABLE?.trim();
  if (explicit) {
    if (yield* isFile(explicit)) return explicit;
    return yield* new AgentBrowserUnavailableError({
      reason: `T3CODE_BROWSER_EXECUTABLE points at a missing file: ${explicit}`,
    });
  }

  const browsersPath = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (browsersPath) {
    const found = yield* findInBrowsersDir(browsersPath);
    if (found !== null) return found;
    return yield* new AgentBrowserUnavailableError({
      reason: `no chromium build found under PLAYWRIGHT_BROWSERS_PATH (${browsersPath})`,
    });
  }

  const locations = probe ?? defaultChromiumProbeLocations(env, yield* HostProcessPlatform);
  for (const dir of locations.browsersDirs) {
    const found = yield* findInBrowsersDir(dir);
    if (found !== null) return found;
  }
  for (const executable of locations.executables) {
    if (yield* isFile(executable)) return executable;
  }

  const probed = [...locations.browsersDirs, ...locations.executables];
  return yield* new AgentBrowserUnavailableError({
    reason: `no Chromium found on this machine${probed.length > 0 ? ` (probed ${probed.join(", ")})` : ""} — run deploy/ensure-browser.sh on the VPS, or install Google Chrome / set T3CODE_BROWSER_EXECUTABLE locally`,
  });
});
