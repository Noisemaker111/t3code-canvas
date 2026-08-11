import { useCallback, useEffect, useRef, useState } from "react";

import {
  appendTranscriptToPrompt,
  LOCAL_STT_MODEL_LABEL,
  transcribeLocalPcm,
} from "~/lib/localStt";
import { startMicCapture, type MicCaptureHandle } from "~/lib/micCapture";

export type DictationPhase = "idle" | "loading" | "recording" | "transcribing";

export type UseComposerDictationOptions = {
  disabled?: boolean;
  prompt: string;
  onPromptChange: (next: string, cursor: number) => void;
  onError: (message: string) => void;
};

/**
 * Toggle mic → record → local Canary STT → append words into the composer.
 */
export function useComposerDictation({
  disabled = false,
  prompt,
  onPromptChange,
  onError,
}: UseComposerDictationOptions) {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const captureRef = useRef<MicCaptureHandle | null>(null);
  const promptRef = useRef(prompt);
  const onPromptChangeRef = useRef(onPromptChange);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);
  useEffect(() => {
    onPromptChangeRef.current = onPromptChange;
  }, [onPromptChange]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    return () => {
      captureRef.current?.cancel();
      captureRef.current = null;
    };
  }, []);

  const stopAndTranscribe = useCallback(async () => {
    const capture = captureRef.current;
    captureRef.current = null;
    if (!capture) {
      setPhase("idle");
      return;
    }
    setPhase("transcribing");
    try {
      const { samples, sampleRate } = await capture.stop();
      if (samples.length < sampleRate * 0.15) {
        onErrorRef.current("That was too short — hold the mic a moment longer.");
        setPhase("idle");
        return;
      }
      const text = await transcribeLocalPcm(samples, sampleRate);
      if (text.length === 0) {
        onErrorRef.current("No speech detected. Try again a bit closer to the mic.");
        setPhase("idle");
        return;
      }
      const next = appendTranscriptToPrompt(promptRef.current, text);
      onPromptChangeRef.current(next, next.length);
    } catch (error) {
      onErrorRef.current(error instanceof Error ? error.message : "Speech recognition failed.");
    } finally {
      setPhase("idle");
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (disabled) return;
    setPhase("loading");
    try {
      // Warm the model while we open the mic so stop→text is faster.
      const [{ getLocalSttModel }, capture] = await Promise.all([
        import("~/lib/localStt"),
        startMicCapture(),
      ]);
      void getLocalSttModel().catch(() => undefined);
      captureRef.current = capture;
      setPhase("recording");
    } catch (error) {
      captureRef.current?.cancel();
      captureRef.current = null;
      setPhase("idle");
      const message =
        error instanceof Error && /Permission|NotAllowed|denied/iu.test(error.message)
          ? "Microphone permission is required for dictation."
          : error instanceof Error
            ? error.message
            : "Could not start the microphone.";
      onErrorRef.current(message);
    }
  }, [disabled]);

  const toggle = useCallback(() => {
    if (disabled) return;
    if (phase === "recording") {
      void stopAndTranscribe();
      return;
    }
    if (phase === "idle") {
      void startRecording();
    }
  }, [disabled, phase, startRecording, stopAndTranscribe]);

  const busy = phase === "loading" || phase === "transcribing";
  const recording = phase === "recording";

  const title =
    phase === "loading"
      ? `Loading ${LOCAL_STT_MODEL_LABEL}…`
      : phase === "recording"
        ? "Stop dictation"
        : phase === "transcribing"
          ? "Transcribing…"
          : `Dictate with ${LOCAL_STT_MODEL_LABEL}`;

  const ariaLabel =
    phase === "recording"
      ? "Stop dictation"
      : phase === "transcribing"
        ? "Transcribing speech"
        : phase === "loading"
          ? "Loading speech model"
          : "Start dictation";

  return {
    phase,
    busy,
    recording,
    title,
    ariaLabel,
    modelLabel: LOCAL_STT_MODEL_LABEL,
    toggle,
  };
}
