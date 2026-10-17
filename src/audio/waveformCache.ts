import type { SpectralWaveform, Track } from '@/types';
import { generateSpectralWaveform } from './decoder';
import { createFileFingerprint, fingerprintToKey, isElectronEnvironment } from './fileImporter';

/**
 * Waveform overviews are cached on disk so the library opens without decoding every file.
 * Format (little endian): 'DJWF', version u8, band count u8, 2 reserved bytes, samples u32, then
 * the low, mid, high and combined bands as u16 per sample (0…1 scaled to 0…65535).
 */
const MAGIC = 'DJWF';
const VERSION = 1;
const HEADER_BYTES = 12;
const BANDS = ['low', 'mid', 'high', 'combined'] as const;
const SCALE = 0xffff;

/** The overview the deck draws: the combined band doubles as the plain waveform. */
export interface WaveformOverview {
  waveformData: number[];
  spectralWaveform: SpectralWaveform;
}

export function encodeWaveform(spectral: SpectralWaveform): Uint8Array {
  const samples = spectral.combined.length;
  const bytes = new Uint8Array(HEADER_BYTES + BANDS.length * samples * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < MAGIC.length; i++) bytes[i] = MAGIC.charCodeAt(i);
  bytes[4] = VERSION;
  bytes[5] = BANDS.length;
  view.setUint32(8, samples, true);
  let offset = HEADER_BYTES;
  for (const band of BANDS) {
    const values = spectral[band];
    for (let i = 0; i < samples; i++) {
      const value = values[i] ?? 0;
      const clamped = value > 1 ? 1 : value < 0 || Number.isNaN(value) ? 0 : value;
      view.setUint16(offset, Math.round(clamped * SCALE), true);
      offset += 2;
    }
  }
  return bytes;
}

/** Null for anything that is not a complete file of the current format. */
export function decodeWaveform(bytes: Uint8Array): WaveformOverview | null {
  if (bytes.byteLength < HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) return null;
  if (bytes[4] !== VERSION || bytes[5] !== BANDS.length) return null;
  const samples = view.getUint32(8, true);
  if (samples === 0 || bytes.byteLength !== HEADER_BYTES + BANDS.length * samples * 2) return null;
  const spectral = { low: [], mid: [], high: [], combined: [] } as SpectralWaveform;
  let offset = HEADER_BYTES;
  for (const band of BANDS) {
    const values = new Array<number>(samples);
    for (let i = 0; i < samples; i++) {
      values[i] = view.getUint16(offset, true) / SCALE;
      offset += 2;
    }
    spectral[band] = values;
  }
  return { waveformData: spectral.combined, spectralWaveform: spectral };
}

function cacheKey(track: Track): string {
  return fingerprintToKey(createFileFingerprint(track));
}

export async function readCachedWaveform(track: Track): Promise<WaveformOverview | null> {
  if (!isElectronEnvironment()) return null;
  try {
    const bytes = await window.electronAPI.waveformRead(cacheKey(track));
    return bytes ? decodeWaveform(new Uint8Array(bytes)) : null;
  } catch (error) {
    console.error('Failed to read cached waveform:', error);
    return null;
  }
}

export async function writeCachedWaveform(track: Track, spectral: SpectralWaveform): Promise<void> {
  if (!isElectronEnvironment()) return;
  try {
    await window.electronAPI.waveformWrite(cacheKey(track), encodeWaveform(spectral));
  } catch (error) {
    console.error('Failed to cache waveform:', error);
  }
}

/** Builds the overview from decoded audio and caches it for the next launch. */
export function waveformFromBuffer(track: Track, audioBuffer: AudioBuffer): WaveformOverview {
  const spectralWaveform = generateSpectralWaveform(audioBuffer);
  void writeCachedWaveform(track, spectralWaveform);
  return { waveformData: spectralWaveform.combined, spectralWaveform };
}

/** The track's overview: already attached, else cached, else built from `decode()`. */
export async function ensureWaveform(track: Track, decode: () => Promise<AudioBuffer>): Promise<WaveformOverview | null> {
  if (track.waveformData && track.spectralWaveform) {
    return { waveformData: track.waveformData, spectralWaveform: track.spectralWaveform };
  }
  const cached = await readCachedWaveform(track);
  if (cached) return cached;
  try {
    return waveformFromBuffer(track, await decode());
  } catch (error) {
    console.error(`Failed to build the waveform of ${track.fileName}:`, error);
    return null;
  }
}
