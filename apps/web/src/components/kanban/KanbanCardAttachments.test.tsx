import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../assets/assetUrls", () => ({
  useAssetUrls: (_environmentId: string, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://board.test/assets/${resource.attachmentId}`),
}));

import { KanbanCardAttachments } from "./KanbanCardAttachments";

describe("KanbanCardAttachments", () => {
  it("renders persisted card media when its signed asset URL is available", () => {
    const markup = renderToStaticMarkup(
      <KanbanCardAttachments
        environmentId={"env-1" as never}
        attachments={[
          {
            id: "shot-1",
            kind: "image",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 4,
            include: true,
          },
        ]}
      />,
    );

    expect(markup).toContain('src="https://board.test/assets/shot-1"');
    expect(markup).toContain("screenshot.png");
  });
});
