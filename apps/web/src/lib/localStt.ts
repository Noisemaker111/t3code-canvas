/**
 * Local speech-to-text for the kanban composer mic.
 *
 * Chosen model: NVIDIA Canary-180M-Flash (INT8 ONNX) via `onnx-asr-web` in the
 * browser — `istupakov/canary-180m-flash-onnx` on Hugging Face.
 *
 * Survey (short):
 * - Canary-180M-Flash (this pick): ~180M params, EN/DE/FR/ES, strong dictation
 *   quality, INT8 encoder+decoder ~213MB first download, WASM CPU (no GPU needed).
 * - Whisper tiny/base (transformers.js / onnx-asr-web): smaller download, weaker
 *   on noisy mics; fine fallback if Canary is too heavy.
 * - Parakeet-TDT 0.6B ONNX: better WER, ~2–3× the download/RAM — too large for
 *   casual composer dictation on this host (no NVIDIA GPU, ~8GB RAM).
 * - NeMo Python Canary: local but needs a Python+CUDA/CPU NeMo stack on the
 *   server — extra host deps we do not want for a composer control.
 * - Web Speech API: free on Chrome but cloud-backed (not local).
 *
 * Runtime assumptions:
 * - Browser must allow microphone permission.
 * - First mic use downloads ORT WASM + Canary INT8 weights from Hugging Face
 *   (cached by the browser afterward). Needs network once; inference is local.
 * - `onnxruntime-web` WASM is loaded from jsDelivr pinned to the installed
 *   package version (see `ORT_WASM_CDN`).
 */
import type { AsrTranscriber } from "onnx-asr-web";

/** Hugging Face ONNX export of nvidia/canary-180m-flash (CC-BY-4.0). */
export const LOCAL_STT_HF_REPO = "istupakov/canary-180m-flash-onnx";

/** Human label for UI / docs. */
export const LOCAL_STT_MODEL_LABEL = "NVIDIA Canary-180M-Flash (INT8, local)";

/** Pin to the apps/web `onnxruntime-web` dependency. */
export const ORT_WASM_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";

let ortConfigured = false;
let modelPromise: Promise<AsrTranscriber> | null = null;

function ensureOrtConfigured(): void {
  if (ortConfigured) return;
  // Dynamic import keeps the ORT/Canary graph out of the initial composer chunk.
  ortConfigured = true;
}

/**
 * Append transcribed words into an existing composer prompt.
 * Inserts a separating space when the prompt already has trailing content.
 */
export function appendTranscriptToPrompt(prompt: string, transcript: string): string {
  const spoken = transcript.trim();
  if (spoken.length === 0) return prompt;
  const base = prompt.replace(/\s+$/u, "");
  if (base.length === 0) return spoken;
  const needsSpace = !/[\s([{/]$/u.test(base);
  return needsSpace ? `${base} ${spoken}` : `${base}${spoken}`;
}

/** Load (and memoize) the Canary INT8 ASR model in-browser. */
export async function getLocalSttModel(): Promise<AsrTranscriber> {
  if (!modelPromise) {
    modelPromise = (async () => {
      ensureOrtConfigured();
      const { configureOrtWeb, loadHuggingfaceModel } = await import("onnx-asr-web/browser");
      configureOrtWeb({ wasmPaths: ORT_WASM_CDN, numThreads: 1 });
      return loadHuggingfaceModel(LOCAL_STT_HF_REPO, {
        quantization: "int8",
        sessionOptions: { executionProviders: ["wasm"] },
      });
    })().catch((error: unknown) => {
      modelPromise = null;
      throw error;
    });
  }
  return modelPromise;
}

/** Transcribe mono PCM with Canary (English ASR + punctuation). */
export async function transcribeLocalPcm(
  samples: Float32Array,
  sampleRate: number,
): Promise<string> {
  if (samples.length === 0) return "";
  const model = await getLocalSttModel();
  const result = await model.transcribeSamples(samples, sampleRate, {
    language: "en",
    pnc: "yes",
  });
  return result.text.trim();
}

/** Test seam: drop the memoized model (does not free ORT WASM). */
export function __resetLocalSttModelForTests(): void {
  modelPromise = null;
  ortConfigured = false;
}
