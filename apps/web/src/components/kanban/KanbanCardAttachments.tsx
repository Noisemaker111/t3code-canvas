import type { EnvironmentId, KanbanCardAttachment } from "@t3tools/contracts";
import { useMemo } from "react";

import { useAssetUrls } from "../../assets/assetUrls";

export function KanbanCardAttachments({
  environmentId,
  attachments,
}: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<KanbanCardAttachment>;
}) {
  const resources = useMemo(
    () =>
      attachments.map((attachment) => ({
        _tag: "attachment" as const,
        attachmentId: attachment.id,
      })),
    [attachments],
  );
  const urls = useAssetUrls(environmentId, resources);
  const visible = attachments.flatMap((attachment, index) => {
    const url = urls[index];
    return url ? [{ attachment, url }] : [];
  });

  if (visible.length === 0) return null;
  return (
    <div className="mt-3 border-t border-border/60 pt-2">
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Attachments
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {visible.map(({ attachment, url }) => (
          <a
            key={attachment.id}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="overflow-hidden rounded-md border border-border/70 bg-muted/20 transition-colors hover:border-ring"
            title={`Open ${attachment.name}`}
          >
            {attachment.kind === "image" ? (
              <img src={url} alt={attachment.name} className="max-h-48 w-full object-contain" />
            ) : (
              <video
                src={url}
                controls
                preload="metadata"
                aria-label={attachment.name}
                className="max-h-48 w-full object-contain"
              />
            )}
            <span className="block truncate px-2 py-1.5 text-[11px] text-muted-foreground">
              {attachment.name}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
