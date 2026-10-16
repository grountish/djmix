import { SoundTouch, SimpleFilter } from 'soundtouchjs';
import { getAudioContext } from './decoder';
import { getMixGraph } from './engine/liveGraph';
import type { PlayheadAnchor } from './engine/transport';

interface StretchProcessor {
  soundTouch: SoundTouch;
  filter: SimpleFilter;
  sourceNode: AudioBufferSourceNode | null;
  scriptNode: ScriptProcessorNode | null;
  isPlaying: boolean;
  currentPosition: number;
  audioBuffer: AudioBuffer | null;
  tempo: number;
  onTimeUpdate?: (time: number) => void;
  onEnded?: () => void;
  animationFrameId?: number;
}

const stretchProcessors: Record<'A' | 'B', StretchProcessor | null> = {
  A: null,
  B: null,
};

const BUFFER_SIZE = 4096;

function createStretchProcessor(audioBuffer: AudioBuffer): StretchProcessor {
  const soundTouch = new SoundTouch();
  soundTouch.tempo = 1.0;
  soundTouch.pitch = 1.0;

  const channelData = extractChannelData(audioBuffer);
  const filter = new SimpleFilter(
    {
      extract: (target: Float32Array, numFrames: number, position: number) => {
        const left = channelData.left;
        const right = channelData.right;

        for (let i = 0; i < numFrames; i++) {
          const sampleIndex = Math.floor(position + i);
          if (sampleIndex >= left.length) {
            return i;
          }
          target[i * 2] = left[sampleIndex];
          target[i * 2 + 1] = right[sampleIndex];
        }
        return numFrames;
      },
    },
    soundTouch,
  );

  return {
    soundTouch,
    filter,
    sourceNode: null,
    scriptNode: null,
    isPlaying: false,
    currentPosition: 0,
    audioBuffer,
    tempo: 1.0,
  };
}

function extractChannelData(audioBuffer: AudioBuffer): { left: Float32Array; right: Float32Array } {
  const left = audioBuffer.getChannelData(0);
  const right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;
  return { left, right };
}

export function initStretchMode(deckId: 'A' | 'B', audioBuffer: AudioBuffer): void {
  stopStretchMode(deckId);
  stretchProcessors[deckId] = createStretchProcessor(audioBuffer);
}

export function playStretchMode(deckId: 'A' | 'B'): void {
  const processor = stretchProcessors[deckId];
  if (!processor || processor.isPlaying || !processor.audioBuffer) return;

  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    ctx.resume();
  }

  const scriptNode = ctx.createScriptProcessor(BUFFER_SIZE, 0, 2);

  const sampleRate = processor.audioBuffer.sampleRate;
  let framePosition = Math.floor(processor.currentPosition * sampleRate);

  scriptNode.onaudioprocess = (event) => {
    const outputL = event.outputBuffer.getChannelData(0);
    const outputR = event.outputBuffer.getChannelData(1);

    const buffer = new Float32Array(BUFFER_SIZE * 2);

    processor.filter.sourcePosition = framePosition;
    const framesExtracted = processor.filter.extract(buffer, BUFFER_SIZE);

    if (framesExtracted === 0) {
      processor.isPlaying = false;
      processor.onEnded?.();
      return;
    }

    for (let i = 0; i < BUFFER_SIZE; i++) {
      outputL[i] = buffer[i * 2] || 0;
      outputR[i] = buffer[i * 2 + 1] || 0;
    }

    framePosition += Math.floor(BUFFER_SIZE * processor.tempo);
    processor.currentPosition = framePosition / sampleRate;
    processor.onTimeUpdate?.(processor.currentPosition);
  };

  scriptNode.connect(getMixGraph().decks[deckId].input);

  processor.scriptNode = scriptNode;
  processor.isPlaying = true;
}

/**
 * Starts stretch playback at audio-clock time `when`. Timer-based, so accurate only to a few
 * milliseconds plus one processing block; the Phase 2 worklet replaces this.
 */
export function playStretchModeAt(deckId: 'A' | 'B', when: number): void {
  const delayMs = Math.max(0, (when - getAudioContext().currentTime) * 1000);
  setTimeout(() => playStretchMode(deckId), delayMs);
}

export function pauseStretchMode(deckId: 'A' | 'B'): void {
  const processor = stretchProcessors[deckId];
  if (!processor || !processor.isPlaying) return;

  if (processor.scriptNode) {
    processor.scriptNode.disconnect();
  }

  processor.scriptNode = null;
  processor.isPlaying = false;
}

export function stopStretchMode(deckId: 'A' | 'B'): void {
  pauseStretchMode(deckId);
  const processor = stretchProcessors[deckId];
  if (processor) {
    processor.currentPosition = 0;
  }
}

export function seekStretchMode(deckId: 'A' | 'B', time: number): void {
  const processor = stretchProcessors[deckId];
  if (!processor || !processor.audioBuffer) return;

  const wasPlaying = processor.isPlaying;
  if (wasPlaying) {
    pauseStretchMode(deckId);
  }

  processor.currentPosition = Math.max(0, Math.min(time, processor.audioBuffer.duration));

  if (wasPlaying) {
    playStretchMode(deckId);
  }
}

export function setStretchTempo(deckId: 'A' | 'B', tempo: number): void {
  const processor = stretchProcessors[deckId];
  if (!processor) return;

  processor.tempo = tempo;
  processor.soundTouch.tempo = tempo;
}

export function getStretchCurrentTime(deckId: 'A' | 'B'): number {
  const processor = stretchProcessors[deckId];
  return processor?.currentPosition || 0;
}

/** Approximate audio-clock anchor; position only advances once per processing block. */
export function getStretchAnchor(deckId: 'A' | 'B'): PlayheadAnchor | null {
  const processor = stretchProcessors[deckId];
  if (!processor?.isPlaying) return null;
  return {
    ctxTime: getAudioContext().currentTime,
    trackTime: processor.currentPosition,
    rate: processor.tempo,
  };
}

export function setStretchTimeUpdateCallback(
  deckId: 'A' | 'B',
  callback: (time: number) => void,
): void {
  const processor = stretchProcessors[deckId];
  if (processor) {
    processor.onTimeUpdate = callback;
  }
}

export function setStretchEndedCallback(deckId: 'A' | 'B', callback: () => void): void {
  const processor = stretchProcessors[deckId];
  if (processor) {
    processor.onEnded = callback;
  }
}

export function isStretchModeInitialized(deckId: 'A' | 'B'): boolean {
  return stretchProcessors[deckId] !== null;
}

// Check if stretch mode is actually playing (ignoring React state)
export function isStretchEnginePlaying(deckId: 'A' | 'B'): boolean {
  const processor = stretchProcessors[deckId];
  return processor?.isPlaying ?? false;
}

// Force stop stretch mode, ensuring audio is stopped regardless of state
export function forceStopStretchMode(deckId: 'A' | 'B'): void {
  const processor = stretchProcessors[deckId];
  if (!processor) return;

  if (processor.scriptNode) {
    try {
      processor.scriptNode.disconnect();
    } catch (e) {
      // Ignore errors
    }
    processor.scriptNode = null;
  }

  processor.isPlaying = false;
}
