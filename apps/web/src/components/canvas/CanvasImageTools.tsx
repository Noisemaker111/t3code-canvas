import { useState } from "react";
import {
  AssetRecordType,
  type Editor,
  type TLAssetId,
  type TLImageShape,
  TldrawUiButton,
  TldrawUiButtonLabel,
  TldrawUiDialogBody,
  TldrawUiDialogFooter,
  TldrawUiDialogHeader,
  TldrawUiDialogTitle,
  type TLUiDialogProps,
  useEditor,
} from "tldraw";

import { toastManager } from "../ui/toast";
import {
  type CanvasImagePayload,
  parseDataUrl,
  requestBackgroundRemoval,
  requestGeneratedImage,
  toDataUrl,
} from "./imageActions";

/**
 * The two picture chores that used to leave the app: prompt → image, and
 * image → transparent cut-out. Both live on the canvas right-click menu
 * ({@link CanvasContextMenu}) and land back on the canvas as ordinary
 * tldraw image shapes, so undo, copy and drag all behave.
 */

const PLACED_MAX_EDGE = 480;

async function imageDimensions(src: string): Promise<{ w: number; h: number }> {
  const image = new Image();
  image.src = src;
  await image.decode();
  return { w: image.naturalWidth, h: image.naturalHeight };
}

async function createImageAsset(
  editor: Editor,
  payload: CanvasImagePayload,
  name: string,
): Promise<{ assetId: TLAssetId; w: number; h: number }> {
  const src = toDataUrl(payload);
  const { w, h } = await imageDimensions(src);
  const assetId = AssetRecordType.createId();
  editor.createAssets([
    {
      id: assetId,
      typeName: "asset",
      type: "image",
      props: { name, src, w, h, mimeType: payload.mediaType, isAnimated: false },
      meta: {},
    },
  ]);
  return { assetId, w, h };
}

async function placeGeneratedImage(editor: Editor, payload: CanvasImagePayload): Promise<void> {
  editor.markHistoryStoppingPoint("generate-image");
  const { assetId, w, h } = await createImageAsset(editor, payload, "generated.png");
  const scale = Math.min(1, PLACED_MAX_EDGE / Math.max(w, h));
  const center = editor.getViewportPageBounds().center;
  editor.createShape<TLImageShape>({
    type: "image",
    x: center.x - (w * scale) / 2,
    y: center.y - (h * scale) / 2,
    props: { assetId, w: w * scale, h: h * scale },
  });
}

async function shapeImagePayload(editor: Editor, shape: TLImageShape): Promise<CanvasImagePayload> {
  const asset = shape.props.assetId ? editor.getAsset(shape.props.assetId) : undefined;
  const src = asset?.type === "image" ? asset.props.src : null;
  if (!src) throw new Error("this image has no readable source");
  const direct = parseDataUrl(src);
  if (direct) return direct;
  const response = await fetch(src, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`could not read the image (HTTP ${response.status})`);
  const blob = await response.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener("error", () => reject(new Error("could not read the image")), {
      once: true,
    });
    reader.readAsDataURL(blob);
  });
  const payload = parseDataUrl(dataUrl);
  if (!payload) throw new Error(`unsupported image type: ${blob.type || "unknown"}`);
  return payload;
}

const inFlightShapes = new Set<string>();

export async function removeBackgroundFromShape(
  editor: Editor,
  shape: TLImageShape,
): Promise<void> {
  const source = await shapeImagePayload(editor, shape);
  const result = await requestBackgroundRemoval(source);
  editor.markHistoryStoppingPoint("remove-image-background");
  const { assetId } = await createImageAsset(editor, result, "cutout.png");
  editor.updateShape<TLImageShape>({ id: shape.id, type: "image", props: { assetId } });
}

/** A transparent request that lands opaque is a failure the canvas cannot show. */
function warnIfOpaque(payload: CanvasImagePayload): void {
  if (payload.transparency !== "opaque") return;
  toastManager.add({
    type: "warning",
    title: "Background is not transparent",
    description: "The model returned a solid background. Try 'Remove background' on the image.",
  });
}

async function withProgressToast(title: string, work: () => Promise<void>): Promise<void> {
  const toastId = toastManager.add({ type: "loading", title, timeout: 0 });
  try {
    await work();
    toastManager.close(toastId);
  } catch (cause) {
    toastManager.close(toastId);
    toastManager.add({
      type: "error",
      title: "Image request failed",
      description: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/** Right-click → "Remove background", for every selected image shape. */
export function runRemoveBackground(editor: Editor, shapes: ReadonlyArray<TLImageShape>): void {
  for (const shape of shapes) {
    if (inFlightShapes.has(shape.id)) continue;
    inFlightShapes.add(shape.id);
    void withProgressToast("Removing background…", () =>
      removeBackgroundFromShape(editor, shape),
    ).finally(() => inFlightShapes.delete(shape.id));
  }
}

/** Right-click → "Generate image…": one prompt box, lands at viewport center. */
export function GenerateImageDialog({ onClose }: TLUiDialogProps) {
  const editor = useEditor();
  const [prompt, setPrompt] = useState("");
  const [transparent, setTransparent] = useState(true);

  const submit = () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    onClose();
    void withProgressToast("Generating image…", async () => {
      const payload = await requestGeneratedImage(trimmed, { transparent });
      await placeGeneratedImage(editor, payload);
      if (transparent) warnIfOpaque(payload);
    });
  };

  return (
    <>
      <TldrawUiDialogHeader>
        <TldrawUiDialogTitle>Generate image</TldrawUiDialogTitle>
      </TldrawUiDialogHeader>
      <TldrawUiDialogBody style={{ width: 320 }}>
        <textarea
          autoFocus
          value={prompt}
          onChange={(event) => setPrompt(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="What should the image show?"
          rows={3}
          style={{ width: "100%", resize: "vertical", font: "inherit" }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
          <input
            type="checkbox"
            checked={transparent}
            onChange={(event) => setTransparent(event.currentTarget.checked)}
          />
          Transparent background
        </label>
      </TldrawUiDialogBody>
      <TldrawUiDialogFooter className="tlui-dialog__footer__actions">
        <TldrawUiButton type="normal" onClick={onClose}>
          <TldrawUiButtonLabel>Cancel</TldrawUiButtonLabel>
        </TldrawUiButton>
        <TldrawUiButton type="primary" disabled={prompt.trim().length === 0} onClick={submit}>
          <TldrawUiButtonLabel>Generate</TldrawUiButtonLabel>
        </TldrawUiButton>
      </TldrawUiDialogFooter>
    </>
  );
}
