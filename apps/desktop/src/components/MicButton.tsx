import { useRef, useState } from "react";
import { getAppPrefs } from "../lib/settingsStore";
import { transcribeAudio } from "../lib/openWebUiClient";
import { useTranslation } from "../lib/i18n";

export interface MicButtonProps {
  baseUrl: string | null;
  apiKey?: string;
  onResult: (text: string) => void;
  onError?: (message: string) => void;
}

// Whisper-family STT models tend to hallucinate a filler word ("You",
// "Thank you.", ...) when the start of the clip is near-silent — common with
// a quick push-to-talk press before the user actually starts speaking. We
// trim that leading silence out before sending audio for transcription.
//
// We capture raw PCM directly (via a ScriptProcessorNode) rather than
// recording through MediaRecorder and decoding the result back with
// AudioContext.decodeAudioData(): that decode step is a known-fragile
// combination for MediaRecorder's streamable WebM/Opus output in Chromium
// (no upfront duration/seek index), and could silently hand back a buffer
// that doesn't match the real recording — producing a syntactically valid
// but effectively empty/garbled WAV. Capturing raw samples ourselves avoids
// that whole class of bug.
const SILENCE_AMPLITUDE_THRESHOLD = 0.02;
const SILENCE_WINDOW_SECONDS = 0.02;
const PRE_ROLL_SECONDS = 0.1;

function encodeWav(channelData: Float32Array, sampleRate: number): Blob {
  const numFrames = channelData.length;
  const blockAlign = 2; // mono, 16-bit
  const dataSize = numFrames * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  function writeString(offset: number, s: string) {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const clamped = Math.max(-1, Math.min(1, channelData[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([out], { type: "audio/wav" });
}

function findVoiceOnsetSample(channelData: Float32Array, sampleRate: number): number {
  const windowSize = Math.max(1, Math.floor(sampleRate * SILENCE_WINDOW_SECONDS));
  for (let i = 0; i < channelData.length; i += windowSize) {
    const end = Math.min(i + windowSize, channelData.length);
    let sum = 0;
    for (let j = i; j < end; j++) sum += Math.abs(channelData[j]);
    if (sum / (end - i) > SILENCE_AMPLITUDE_THRESHOLD) return i;
  }
  return -1;
}

function buildTrimmedWavBlob(channelData: Float32Array, sampleRate: number): Blob {
  const onsetSample = findVoiceOnsetSample(channelData, sampleRate);
  let startSample = 0;
  if (onsetSample !== -1) {
    const preRollSamples = Math.floor(sampleRate * PRE_ROLL_SECONDS);
    startSample = Math.max(0, onsetSample - preRollSamples);
  }
  const trimmed = startSample > 0 ? channelData.subarray(startSample) : channelData;
  return encodeWav(trimmed, sampleRate);
}

function describeMicError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") {
      return "Microphone access was denied. Check your system's privacy/microphone settings and try again.";
    }
    if (err.name === "NotFoundError") {
      return "No microphone was found.";
    }
  }
  return err instanceof Error ? `Could not start recording: ${err.message}` : "Could not start recording.";
}

interface ActiveRecording {
  stream: MediaStream;
  audioCtx: AudioContext;
  processor: ScriptProcessorNode;
  silentGain: GainNode;
  chunks: Float32Array[];
}

export default function MicButton({ baseUrl, apiKey, onResult, onError }: MicButtonProps) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const recordingRef = useRef<ActiveRecording | null>(null);

  function fail(message: string) {
    setLocalError(message);
    onError?.(message);
  }

  async function handleTranscribe(blob: Blob) {
    if (!baseUrl) {
      fail("Configure your Open WebUI server in Settings first.");
      return;
    }
    setTranscribing(true);
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const text = await transcribeAudio(baseUrl, apiKey, bytes, blob.type || "audio/wav");
      if (text.trim()) onResult(text.trim());
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setTranscribing(false);
    }
  }

  async function startRecording() {
    if (recordingRef.current) return;
    setLocalError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      fail("Audio recording isn't supported in this app.");
      return;
    }
    const AudioContextCtor =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      fail("Audio recording isn't supported in this app.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioCtx = new AudioContextCtor();
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      const silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;
      const chunks: Float32Array[] = [];
      processor.onaudioprocess = (e) => {
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      // ScriptProcessorNode only fires onaudioprocess while connected to a
      // destination — route through a zero-gain node so that requirement is
      // satisfied without audibly echoing the mic back through speakers.
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioCtx.destination);

      recordingRef.current = { stream, audioCtx, processor, silentGain, chunks };
      setRecording(true);
    } catch (err) {
      fail(describeMicError(err));
    }
  }

  function stopRecording() {
    const active = recordingRef.current;
    if (!active) return;
    recordingRef.current = null;
    setRecording(false);

    const { stream, audioCtx, processor, silentGain, chunks } = active;
    processor.disconnect();
    silentGain.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    const sampleRate = audioCtx.sampleRate;
    void audioCtx.close();

    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    setTranscribing(true);
    void (async () => {
      try {
        const blob = buildTrimmedWavBlob(combined, sampleRate);
        await handleTranscribe(blob);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
        setTranscribing(false);
      }
    })();
  }

  async function getMicMode() {
    const prefs = await getAppPrefs();
    return prefs?.micMode ?? "toggle";
  }

  async function handleClick() {
    const mode = await getMicMode();
    if (mode !== "toggle") return;
    if (recording) stopRecording();
    else await startRecording();
  }

  async function handleMouseDown() {
    const mode = await getMicMode();
    if (mode !== "push-to-talk") return;
    await startRecording();
  }

  function handleMouseUp() {
    if (recording) stopRecording();
  }

  function handleMouseLeave() {
    if (recording) stopRecording();
  }

  const busy = recording || transcribing;

  return (
    <button
      type="button"
      className={`mic-button${recording ? " active" : ""}`}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      title={
        localError ??
        (transcribing
          ? t("composer.micTranscribing")
          : recording
            ? t("composer.micRecording")
            : t("composer.micSpeak"))
      }
    >
      {busy ? "⏺" : "🎤"}
    </button>
  );
}
