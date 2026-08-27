/**
 * Capture microphone audio as mono Float32 PCM for local STT.
 * Uses AudioContext + ScriptProcessor so we never depend on MediaRecorder
 * container codecs that decodeAudioData may reject.
 */

export type MicCaptureHandle = {
  /** Stop capture and return the recorded mono PCM. */
  stop: () => Promise<{ samples: Float32Array; sampleRate: number }>;
  /** Release the mic without returning samples (cancel). */
  cancel: () => void;
};

const TARGET_SAMPLE_RATE = 16_000;

function mixToMono(input: Float32Array, channelCount: number): Float32Array {
  if (channelCount <= 1) return input;
  const frames = Math.floor(input.length / channelCount);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < channelCount; ch += 1) {
      sum += input[i * channelCount + ch] ?? 0;
    }
    mono[i] = sum / channelCount;
  }
  return mono;
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const src = i * ratio;
    const left = Math.floor(src);
    const right = Math.min(left + 1, input.length - 1);
    const frac = src - left;
    const a = input[left] ?? 0;
    const b = input[right] ?? 0;
    output[i] = a + (b - a) * frac;
  }
  return output;
}

/**
 * Start microphone capture. Call `stop()` to end and get PCM at 16 kHz mono.
 */
export async function startMicCapture(): Promise<MicCaptureHandle> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone capture is not available in this browser.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioCtx();
  if (context.state === "suspended") {
    await context.resume();
  }
  const source = context.createMediaStreamSource(stream);
  const chunks: Float32Array[] = [];
  let totalSamples = 0;
  let closed = false;

  // ScriptProcessor is deprecated but still the portable path without a worklet file.
  const bufferSize = 4096;
  const processor = context.createScriptProcessor(bufferSize, 1, 1);
  processor.onaudioprocess = (event) => {
    if (closed) return;
    const input = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    totalSamples += input.length;
  };

  // Keep the processor in the graph without playing mic audio back to the speakers.
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);

  const tearDown = () => {
    if (closed) return;
    closed = true;
    processor.onaudioprocess = null;
    try {
      processor.disconnect();
    } catch {
      // already disconnected
    }
    try {
      source.disconnect();
    } catch {
      // already disconnected
    }
    try {
      mute.disconnect();
    } catch {
      // already disconnected
    }
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => undefined);
  };

  return {
    cancel: tearDown,
    stop: async () => {
      const nativeRate = context.sampleRate;
      tearDown();
      const merged = new Float32Array(totalSamples);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      const mono = mixToMono(merged, 1);
      const samples = resampleLinear(mono, nativeRate, TARGET_SAMPLE_RATE);
      return { samples, sampleRate: TARGET_SAMPLE_RATE };
    },
  };
}
