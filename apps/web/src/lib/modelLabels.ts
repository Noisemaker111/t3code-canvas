/**
 * Display labels for multi-router catalogs (OpenCode → openrouter / opencode-zen / …).
 */

export type RoutedModelLike = {
  readonly slug: string;
  readonly name?: string;
  readonly shortName?: string;
  readonly subProvider?: string;
};

/** `Open Router` / `OpenCode Zen` → `openrouter` / `opencode-zen`. */
export function subProviderRoutePrefix(subProvider: string | undefined): string | null {
  const raw = subProvider?.trim();
  if (!raw) return null;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug.length > 0 ? slug : null;
}

/**
 * Prefer `openrouter/Aion-2.0` style labels. If the wire slug already has a
 * path (`provider/model`), use it as-is.
 */
export function formatRoutedModelLabel(option: RoutedModelLike): string {
  const slug = option.slug.trim();
  if (slug.includes("/")) return slug;
  const prefix = subProviderRoutePrefix(option.subProvider);
  const leaf = option.shortName?.trim() || option.name?.trim() || slug;
  return prefix ? `${prefix}/${leaf}` : leaf;
}

export function modelMatchesSearch(option: RoutedModelLike, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    option.slug,
    option.name,
    option.shortName,
    option.subProvider,
    formatRoutedModelLabel(option),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}
