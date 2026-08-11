import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  applyKeepAttachmentIds,
  decodeAttachmentsJson,
  encodeAttachmentsJson,
  hermesImagesFromCardAttachments,
  persistKanbanUploads,
  readKanbanAttachmentBytes,
} from "./kanbanAttachments.ts";

describe("kanbanAttachments", () => {
  it("round-trips metadata JSON and keep flags", () => {
    const encoded = encodeAttachmentsJson([
      {
        id: "a1",
        kind: "image",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 12,
        include: true,
      },
      {
        id: "a2",
        kind: "video",
        name: "clip.webm",
        mimeType: "video/webm",
        sizeBytes: 99,
        include: true,
      },
    ]);
    const decoded = decodeAttachmentsJson(encoded);
    expect(decoded).toHaveLength(2);
    const next = applyKeepAttachmentIds(decoded, ["a1"]);
    expect(next.find((entry) => entry.id === "a1")?.include).toBe(true);
    expect(next.find((entry) => entry.id === "a2")?.include).toBe(false);
    expect(applyKeepAttachmentIds(decoded, undefined)[1]?.include).toBe(true);
    expect(applyKeepAttachmentIds(decoded, [])).toEqual([
      expect.objectContaining({ id: "a1", include: false }),
      expect.objectContaining({ id: "a2", include: false }),
    ]);
  });

  it("persists upload bytes to disk and reads them back", () => {
    const attachmentsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kanban-att-"));
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const result = persistKanbanUploads({
        attachmentsDir,
        ids: ["att-1"],
        uploads: [
          {
            kind: "image",
            name: "tiny.png",
            mimeType: "image/png",
            sizeBytes: png.byteLength,
            dataUrl: `data:image/png;base64,${png.toString("base64")}`,
          },
        ],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.attachments[0]?.id).toBe("att-1");
      const bytes = readKanbanAttachmentBytes({
        attachmentsDir,
        attachment: result.attachments[0]!,
      });
      expect(bytes?.equals(png)).toBe(true);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("rejects mime/kind mismatches without writing", () => {
    const attachmentsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kanban-att-"));
    try {
      const result = persistKanbanUploads({
        attachmentsDir,
        ids: ["att-bad"],
        uploads: [
          {
            kind: "video",
            name: "not-video.png",
            mimeType: "image/png",
            sizeBytes: 4,
            dataUrl: "data:image/png;base64,AAAA",
          },
        ],
      });
      expect(result.ok).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(attachmentsDir, "kanban"))).toBe(true);
      expect(NodeFS.readdirSync(NodePath.join(attachmentsDir, "kanban"))).toHaveLength(0);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("fails closed when Hermes cannot read an included image", () => {
    const attachmentsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kanban-att-"));
    try {
      expect(() =>
        hermesImagesFromCardAttachments({
          attachmentsDir,
          attachments: [
            {
              id: "missing",
              kind: "image",
              name: "missing.png",
              mimeType: "image/png",
              sizeBytes: 4,
              include: true,
            },
          ],
        }),
      ).toThrow("missing or empty");
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
