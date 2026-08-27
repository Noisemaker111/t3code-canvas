import { describe, expect, it } from "vite-plus/test";

import {
  acceptKanbanMediaFiles,
  filesFromClipboard,
  kanbanComposerHasSendableContent,
  kanbanMediaKindForFile,
  toComposerMediaAttachment,
} from "./kanbanComposerMedia";

describe("kanbanComposerMedia", () => {
  it("classifies image and video mime types", () => {
    expect(kanbanMediaKindForFile(new File([], "a.png", { type: "image/png" }))).toBe("image");
    expect(kanbanMediaKindForFile(new File([], "a.webm", { type: "video/webm" }))).toBe("video");
    expect(kanbanMediaKindForFile(new File([], "a.txt", { type: "text/plain" }))).toBeNull();
  });

  it("accepts mixed media under the attachment cap", () => {
    const result = acceptKanbanMediaFiles({
      currentCount: 0,
      files: [
        new File([new Uint8Array(10)], "shot.png", { type: "image/png" }),
        new File([new Uint8Array(10)], "clip.webm", { type: "video/webm" }),
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.files).toHaveLength(2);
  });

  it("rejects unsupported types and oversize files", () => {
    const badType = acceptKanbanMediaFiles({
      currentCount: 0,
      files: [new File([new Uint8Array(4)], "notes.txt", { type: "text/plain" })],
    });
    expect(badType.ok).toBe(false);

    const oversize = acceptKanbanMediaFiles({
      currentCount: 0,
      files: [new File([new Uint8Array(11 * 1024 * 1024)], "huge.png", { type: "image/png" })],
    });
    expect(oversize.ok).toBe(false);
  });

  it("allows send with media-only or text-only", () => {
    expect(kanbanComposerHasSendableContent({ prompt: "", mediaCount: 1 })).toBe(true);
    expect(kanbanComposerHasSendableContent({ prompt: "hi", mediaCount: 0 })).toBe(true);
    expect(kanbanComposerHasSendableContent({ prompt: "  ", mediaCount: 0 })).toBe(false);
  });

  it("builds a draft attachment with a preview URL", () => {
    const file = new File([new Uint8Array(4)], "ui.png", { type: "image/png" });
    const attachment = toComposerMediaAttachment(file);
    expect(attachment?.mimeType).toBe("image/png");
    expect(attachment?.previewUrl.startsWith("blob:")).toBe(true);
    if (attachment) URL.revokeObjectURL(attachment.previewUrl);
  });

  it("reads pasted image files from clipboard data", () => {
    const blob = new File([new Uint8Array(4)], "", { type: "image/png" });
    const data = {
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => blob,
        },
      ],
    } as unknown as DataTransfer;
    const files = filesFromClipboard(data);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toContain("pasted-image");
  });
});
