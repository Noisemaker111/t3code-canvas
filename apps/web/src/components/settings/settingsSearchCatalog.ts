import type { SettingsSectionPath } from "./settingsStations";

export type SettingsSearchItem = {
  readonly id: string;
  readonly section: string;
  readonly path: SettingsSectionPath;
  readonly title: string;
  readonly description: string;
  readonly keywords?: ReadonlyArray<string>;
};

/**
 * Flat catalog of user-facing settings for global search. Keep titles and
 * descriptions aligned with the live Settings rows so highlight matches what
 * people see on each page.
 */
export const SETTINGS_SEARCH_CATALOG: ReadonlyArray<SettingsSearchItem> = [
  // General
  {
    id: "general.theme",
    section: "General",
    path: "/settings/general",
    title: "Theme",
    description: "Choose how T3 Code looks across the app.",
    keywords: ["dark", "light", "system", "appearance"],
  },
  {
    id: "general.time-format",
    section: "General",
    path: "/settings/general",
    title: "Time format",
    description: "System default follows your browser or OS clock preference.",
    keywords: ["12-hour", "24-hour", "clock", "timestamp"],
  },
  {
    id: "general.word-wrap",
    section: "General",
    path: "/settings/general",
    title: "Word wrap",
    description: "Wrap long lines in code blocks, tables, diffs, and file previews by default.",
    keywords: ["wrap", "code", "diff"],
  },
  {
    id: "source-control.git-fetch",
    section: "Connections",
    path: "/settings/source-control",
    title: "Automatic git fetch",
    description: "How often T3 Code fetches remote git state for branches and pull requests.",
    keywords: ["fetch", "git", "interval"],
  },
  {
    id: "general.confirm-delete",
    section: "General",
    path: "/settings/general",
    title: "Confirm thread delete",
    description: "Ask before permanently deleting a thread.",
    keywords: ["delete", "confirm", "thread"],
  },

  // Board
  {
    id: "board.always-on-skills",
    section: "Board",
    path: "/settings/board",
    title: "Always-on skills",
    description: "Skills applied when you run Apply skills on a Draft card.",
    keywords: ["skills", "draft", "apply", "kanban"],
  },
  {
    id: "board.pipeline",
    section: "Board",
    path: "/settings/board",
    title: "Draft skills & promote",
    description: "Skill pipeline order and auto-promote Draft → Prompts after skills.",
    keywords: ["promote", "skills", "prompts", "queue"],
  },
  {
    id: "board.canvas-ui",
    section: "Board",
    path: "/settings/board",
    title: "Canvas UI",
    description:
      "Which tldraw tools, colors, minimap and menus the canvas shows. Minimal by default; the stock UI is one preset away.",
    keywords: [
      "canvas",
      "tldraw",
      "toolbar",
      "tools",
      "colors",
      "minimap",
      "minimal",
      "shapes",
      "draw",
      "style panel",
    ],
  },
  {
    id: "board.canvas-licence",
    section: "Board",
    path: "/settings/board",
    title: "Canvas licence",
    description: "The tldraw key the canvas runs on. Without one the board blanks itself.",
    keywords: ["tldraw", "licence", "license", "key", "canvas", "expiry", "watermark"],
  },
  {
    id: "hermes.pipeline",
    section: "Hermes",
    path: "/settings/hermes",
    title: "Pipeline switches",
    description:
      "What Hermes may do with a card each tick: structure, launch, finish, merge, helpers, timeouts.",
    keywords: ["hermes", "policy", "auto-launch", "stuck", "pipeline", "merge", "helper"],
  },

  // Hermes board brain
  {
    id: "hermes.enable",
    section: "Hermes",
    path: "/settings/hermes",
    title: "Enable Hermes",
    description: "The board brain loop: structure, launch, nudge, PR → merge. On by default.",
    keywords: ["hermes", "brain", "loop", "board", "grok", "tick"],
  },
  {
    id: "hermes.preflight",
    section: "Hermes",
    path: "/settings/hermes",
    title: "Box checks",
    description:
      "The checks Hermes runs before it spends a tick, and the button that repairs them.",
    keywords: ["hermes", "preflight", "health", "forge", "gh", "pull request", "blocked", "fix"],
  },
  {
    id: "hermes.model",
    section: "Hermes",
    path: "/settings/hermes",
    title: "Board brain model",
    description:
      "One provider + model selection the brain runs on — an unavailable pick fails the tick visibly, no fallback chain.",
    keywords: ["hermes", "model", "grok", "openrouter", "cursor", "backend", "provider", "slug"],
  },
  {
    id: "hermes.log",
    section: "Hermes",
    path: "/settings/hermes",
    title: "Tick log",
    description: "Recent ticks with transcripts, dry run, and run-now.",
    keywords: ["hermes", "log", "tick", "transcript", "dry run", "history"],
  },

  {
    id: "hermes.telemetry",
    section: "Hermes",
    path: "/settings/hermes",
    title: "Tick log on disk",
    description: "Where ticks are written and how to read them from the journal.",
    keywords: ["hermes", "log", "telemetry", "journal", "jsonl", "debug"],
  },
  {
    id: "archive.cards",
    section: "Board",
    path: "/settings/archived",
    title: "Archived cards",
    description: "Cards taken off the board. Restore puts one back in its column.",
    keywords: ["archive", "card", "restore", "board", "hidden"],
  },

  // Keybindings
  {
    id: "keybindings",
    section: "General",
    path: "/settings/keybindings",
    title: "Keybindings",
    description: "Customize keyboard shortcuts for chat, navigation, and the command palette.",
    keywords: ["shortcut", "hotkey", "keyboard", "command palette"],
  },

  // Models
  {
    id: "models.default",
    section: "Models",
    path: "/settings/models",
    title: "New threads",
    description: "Used for every new thread unless the project or thread picks its own model.",
    keywords: ["model", "provider", "default", "default model"],
  },
  {
    id: "models.text-gen",
    section: "Models",
    path: "/settings/models",
    title: "Git text generation",
    description: "Commit messages, PR titles, branch names, and similar generated Git text.",
    keywords: ["commit", "pr", "git", "model", "text generation"],
  },
  {
    id: "models.auto-router",
    section: "Models",
    path: "/settings/models",
    title: "Auto Router",
    description: "Choose coding models directly for small, medium, and large board tasks.",
    keywords: ["hermes", "model", "board", "launch", "agent", "project type", "task size"],
  },
  {
    id: "models.roster",
    section: "Models",
    path: "/settings/models",
    title: "Auto Router rules",
    description:
      "One sentence per model saying what it is for, in preference order — the board routes by these.",
    keywords: ["auto router", "roster", "rule", "small", "medium", "large", "size", "routing"],
  },
  {
    id: "models.list",
    section: "Models",
    path: "/settings/models",
    title: "Models list",
    description: "Browse, search, and manage models reported by each provider instance.",
    keywords: ["models", "favorites", "custom models"],
  },

  // Global Skills
  {
    id: "skills.global",
    section: "Board",
    path: "/settings/skill-commands",
    title: "Global Skills",
    description:
      "Slash templates for the composer and Kanban board. Not agent auto-skills. Import from skills.sh.",
    keywords: ["slash", "skill", "skills.sh", "research", "structure", "template"],
  },
  {
    id: "skills.import",
    section: "Board",
    path: "/settings/skill-commands",
    title: "Import from skills.sh",
    description:
      "Search keywords or paste owner/repo/skill to import a SKILL.md as a global skill.",
    keywords: ["import", "skills.sh", "npx skills", "find"],
  },

  // VPS
  {
    id: "vps.host",
    section: "System",
    path: "/settings/vps",
    title: "Host",
    description: "Hostname, OS, kernel, uptime and the running T3J server process.",
    keywords: ["vps", "server", "host", "uptime", "kernel", "devbox"],
  },
  {
    id: "vps.load",
    section: "System",
    path: "/settings/vps",
    title: "Load",
    description: "CPU utilisation, load average, memory and swap usage.",
    keywords: ["cpu", "memory", "ram", "swap", "load"],
  },
  {
    id: "vps.storage",
    section: "System",
    path: "/settings/vps",
    title: "Storage",
    description:
      "Disk capacity per mount, plus sizes of the releases, install log and project directories.",
    keywords: ["disk", "storage", "capacity", "df", "space", "full"],
  },
  {
    id: "vps.services",
    section: "System",
    path: "/settings/vps",
    title: "Services",
    description: "systemd units for the stack, with start, stop and restart.",
    keywords: ["systemd", "service", "unit", "restart", "timer", "t3j"],
  },
  {
    id: "vps.processes",
    section: "System",
    path: "/settings/vps",
    title: "Processes",
    description: "Heaviest processes on the box, with SIGTERM and SIGKILL.",
    keywords: ["process", "ps", "kill", "cpu", "agent"],
  },
  {
    id: "vps.ports",
    section: "System",
    path: "/settings/vps",
    title: "Listening ports",
    description: "TCP and UDP sockets bound on the host and the process behind each.",
    keywords: ["port", "socket", "listen", "network", "ss"],
  },

  // Connections (single page with section headers)
  {
    id: "connections.providers",
    section: "Connections",
    path: "/settings/connections",
    title: "Providers",
    description:
      "Connect coding-agent CLIs (Claude, Codex, Cursor, Grok, OpenCode). Update, log in, and configure instances.",
    keywords: [
      "claude",
      "codex",
      "cursor",
      "grok",
      "opencode",
      "auth",
      "login",
      "update",
      "install",
      "cli",
    ],
  },
  {
    id: "connections.providers.add",
    section: "Connections",
    path: "/settings/connections",
    title: "Add provider instance",
    description:
      "Add another configured instance of a provider (e.g. a second Claude or Codex home).",
    keywords: ["instance", "add", "provider"],
  },
  {
    id: "connections.api-keys",
    section: "Connections",
    path: "/settings/connections",
    title: "API keys",
    description:
      "Paste provider API keys (OpenRouter, Grok, Cursor). The OpenRouter key drives Hermes, the Auto Router, the model bench, OpenCode runs, and usage.",
    keywords: [
      "api key",
      "openrouter",
      "token",
      "secret",
      "credential",
      "usage",
      "grok",
      "cursor",
      "hermes",
    ],
  },
  {
    id: "connections.source-control",
    section: "Connections",
    path: "/settings/connections",
    title: "Source Control",
    description: "GitHub, GitLab, and other git remotes used to clone and publish repositories.",
    keywords: ["git", "github", "gitlab", "clone", "remote", "auth"],
  },
  {
    id: "connections.access",
    section: "Connections",
    path: "/settings/connections",
    title: "Access & devices",
    description: "Pairing links, authorized client sessions, and how this backend is reached.",
    keywords: ["pair", "pairing", "phone", "device", "session", "client", "access"],
  },
  {
    id: "connections.updates",
    section: "Connections",
    path: "/settings/connections",
    title: "Updates",
    description: "Check for and install T3J / vps-code updates on this server.",
    keywords: ["update", "deploy", "install", "version", "restart"],
  },

  // Archive
  {
    id: "archive.threads",
    section: "Board",
    path: "/settings/archived",
    title: "Archived threads",
    description: "Browse and restore threads you have archived.",
    keywords: ["archive", "thread", "restore"],
  },

  // Maintenance
  {
    id: "maintenance.friction",
    section: "System",
    path: "/settings/maintenance",
    title: "Clear the friction log",
    description: "Delete every papercut entry. Irreversible, confirmed by count.",
    keywords: ["clear", "delete", "purge", "friction", "papercut", "maintenance", "reset"],
  },
  {
    id: "maintenance.archived",
    section: "System",
    path: "/settings/maintenance",
    title: "Purge archived history",
    description:
      "Delete archived and soft-deleted threads, archived cards, and their transcripts. Live data is untouched.",
    keywords: ["purge", "delete", "archived", "thread", "card", "history", "transcript", "space"],
  },
  {
    id: "maintenance.hermes-logs",
    section: "System",
    path: "/settings/maintenance",
    title: "Clear Hermes tick and usage logs",
    description: "Delete ticks.jsonl and usage.jsonl. Hermes keeps running.",
    keywords: ["hermes", "log", "tick", "usage", "clear", "delete", "jsonl"],
  },
  {
    id: "maintenance.canvas",
    section: "System",
    path: "/settings/maintenance",
    title: "Wipe the canvas",
    description:
      "Delete the whole tldraw document. Never automatic — this button is the only path.",
    keywords: ["canvas", "wipe", "clear", "tldraw", "drawing", "reset", "delete"],
  },

  // Performance
  {
    id: "performance.record",
    section: "System",
    path: "/settings/performance",
    title: "Record performance",
    description: "Record while the app lags, then read what cost the time and copy it as a report.",
    keywords: ["perf", "lag", "slow", "profile", "fps", "jank", "stutter", "rebuild", "report"],
  },
];

export type SettingsSearchMatch = SettingsSearchItem & {
  readonly score: number;
};

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** Rank catalog items by title / description / keyword match. */
export function searchSettingsCatalog(query: string): ReadonlyArray<SettingsSearchMatch> {
  const q = normalizeQuery(query);
  if (q.length === 0) return [];

  const tokens = q.split(/\s+/).filter(Boolean);
  const results: SettingsSearchMatch[] = [];

  for (const item of SETTINGS_SEARCH_CATALOG) {
    const haystack = [item.title, item.description, item.section, ...(item.keywords ?? [])]
      .join(" ")
      .toLowerCase();

    if (!tokens.every((token) => haystack.includes(token))) continue;

    let score = 0;
    const titleLower = item.title.toLowerCase();
    if (titleLower === q) score += 100;
    else if (titleLower.startsWith(q)) score += 60;
    else if (titleLower.includes(q)) score += 40;
    for (const token of tokens) {
      if (titleLower.includes(token)) score += 15;
      if (item.description.toLowerCase().includes(token)) score += 8;
      if ((item.keywords ?? []).some((k) => k.toLowerCase().includes(token))) score += 10;
      if (item.section.toLowerCase().includes(token)) score += 5;
    }
    results.push({ ...item, score });
  }

  return results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

/** Split text into plain and highlighted segments for the current query. */
export function highlightQuerySegments(
  text: string,
  query: string,
): ReadonlyArray<{ text: string; match: boolean }> {
  const q = query.trim();
  if (q.length === 0 || text.length === 0) {
    return [{ text, match: false }];
  }

  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  // Prefer whole-query match; fall back to first token.
  const token =
    lower.includes(needle) && needle.length > 0
      ? needle
      : (q.split(/\s+/).find((t) => t.length > 0 && lower.includes(t.toLowerCase())) ?? "");
  if (token.length === 0) return [{ text, match: false }];

  const segments: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  const tokenLower = token.toLowerCase();
  while (cursor < text.length) {
    const idx = text.toLowerCase().indexOf(tokenLower, cursor);
    if (idx === -1) {
      segments.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (idx > cursor) {
      segments.push({ text: text.slice(cursor, idx), match: false });
    }
    segments.push({ text: text.slice(idx, idx + token.length), match: true });
    cursor = idx + token.length;
  }
  return segments;
}
