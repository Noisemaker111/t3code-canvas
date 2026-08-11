/**
 * Group model-picker rows by provider / router so lists are sectioned instead
 * of one flat dump (critical for OpenCode multi-upstream catalogs).
 */

export type ModelPickerSectionable = {
  readonly instanceId: string;
  readonly instanceDisplayName: string;
  readonly slug: string;
  readonly subProvider?: string | undefined;
};

export type ModelPickerListRow<T extends ModelPickerSectionable> =
  | { readonly kind: "section"; readonly id: string; readonly label: string }
  | {
      readonly kind: "model";
      readonly id: string;
      readonly model: T;
      readonly comboboxIndex: number;
    };

/** Section label for a model: upstream router when present, else harness/instance. */
export function modelPickerSectionLabel(
  model: ModelPickerSectionable,
  options: { readonly multiInstance: boolean },
): string {
  const sub = model.subProvider?.trim();
  if (sub) {
    return options.multiInstance ? `${model.instanceDisplayName} · ${sub}` : sub;
  }
  return model.instanceDisplayName;
}

/**
 * Build virtualized list rows with section headers.
 * Returns models only (no headers) when every row shares one section —
 * e.g. a plain Codex list with no upstream routers.
 */
export function buildModelPickerSectionedRows<T extends ModelPickerSectionable>(
  models: ReadonlyArray<T>,
): ReadonlyArray<ModelPickerListRow<T>> {
  if (models.length === 0) return [];

  const instanceIds = new Set(models.map((model) => model.instanceId));
  const multiInstance = instanceIds.size > 1;
  const hasAnySubProvider = models.some((model) => Boolean(model.subProvider?.trim()));

  // Single harness, no routers → flat list (Codex / Claude default catalogs).
  if (!multiInstance && !hasAnySubProvider) {
    return models.map((model, comboboxIndex) => ({
      kind: "model" as const,
      id: `${model.instanceId}:${model.slug}`,
      model,
      comboboxIndex,
    }));
  }

  // Preserve first-seen section order from the already-sorted model list.
  const sectionOrder: string[] = [];
  const bySection = new Map<string, T[]>();
  for (const model of models) {
    const label = modelPickerSectionLabel(model, { multiInstance });
    const bucket = bySection.get(label);
    if (bucket) {
      bucket.push(model);
    } else {
      sectionOrder.push(label);
      bySection.set(label, [model]);
    }
  }

  // One section only → still flat (avoid a lone redundant header).
  if (sectionOrder.length <= 1) {
    return models.map((model, comboboxIndex) => ({
      kind: "model" as const,
      id: `${model.instanceId}:${model.slug}`,
      model,
      comboboxIndex,
    }));
  }

  const rows: Array<ModelPickerListRow<T>> = [];
  let comboboxIndex = 0;
  for (const label of sectionOrder) {
    const sectionModels = bySection.get(label) ?? [];
    rows.push({
      kind: "section",
      id: `section:${label}`,
      label,
    });
    for (const model of sectionModels) {
      rows.push({
        kind: "model",
        id: `${model.instanceId}:${model.slug}`,
        model,
        comboboxIndex,
      });
      comboboxIndex += 1;
    }
  }
  return rows;
}

export function modelPickerListShowsSections<T extends ModelPickerSectionable>(
  rows: ReadonlyArray<ModelPickerListRow<T>>,
): boolean {
  return rows.some((row) => row.kind === "section");
}
