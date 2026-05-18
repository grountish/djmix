import { v4 as uuidv4 } from 'uuid';
import type { Track, FileFingerprint } from '@/types';
import {
  decodeAudioFile,
  generateWaveformData,
  decodeAudioFromFile,
  generateSpectralWaveform,
} from './decoder';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

export function extractFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

interface TrackMetadata {
  artwork?: string;
  artist?: string;
  title?: string;
  album?: string;
}

async function extractMetadataFromFile(file: File): Promise<TrackMetadata> {
  try {
    const { parseBlob } = await import('music-metadata');
    const metadata = await parseBlob(file);

    let artwork: string | undefined;
    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const picture = metadata.common.picture[0];
      const base64 = btoa(
        new Uint8Array(picture.data).reduce((data, byte) => data + String.fromCharCode(byte), ''),
      );
      artwork = `data:${picture.format};base64,${base64}`;
    }

    return {
      artwork,
      artist: metadata.common.artist,
      title: metadata.common.title,
      album: metadata.common.album,
    };
  } catch (error) {
    console.error('Failed to extract metadata:', error);
    return {};
  }
}

export async function createTrackFromFile(filePath: string): Promise<Track> {
  const stats = await window.electronAPI.getFileStats(filePath);
  const audioBuffer = await decodeAudioFile(filePath);
  const waveformData = generateWaveformData(audioBuffer);
  const spectralWaveform = generateSpectralWaveform(audioBuffer);

  // Get metadata from electron main process
  let metadata: TrackMetadata = {};
  try {
    metadata = await window.electronAPI.getAudioMetadata(filePath);
  } catch {
    // Ignore metadata errors
  }

  return {
    id: uuidv4(),
    filePath,
    fileName: extractFileName(filePath),
    duration: audioBuffer.duration,
    fileSize: stats.size,
    analysis: null,
    analysisStatus: 'pending',
    waveformData,
    spectralWaveform,
    ...metadata,
  };
}

export async function createTrackFromBrowserFile(file: File): Promise<Track> {
  const audioBuffer = await decodeAudioFromFile(file);
  const waveformData = generateWaveformData(audioBuffer);
  const spectralWaveform = generateSpectralWaveform(audioBuffer);
  const metadata = await extractMetadataFromFile(file);

  return {
    id: uuidv4(),
    filePath: file.name,
    fileName: file.name,
    duration: audioBuffer.duration,
    fileSize: file.size,
    analysis: null,
    analysisStatus: 'pending',
    waveformData,
    spectralWaveform,
    ...metadata,
    _audioBuffer: audioBuffer,
  } as Track & { _audioBuffer: AudioBuffer };
}

export function createFileFingerprint(track: Track): FileFingerprint {
  return {
    fileName: track.fileName,
    fileSize: track.fileSize,
    duration: Math.round(track.duration * 100) / 100,
  };
}

export function fingerprintToKey(fingerprint: FileFingerprint): string {
  return `${fingerprint.fileName}|${fingerprint.fileSize}|${fingerprint.duration}`;
}

export async function importFiles(): Promise<string[]> {
  if (isElectron) {
    return window.electronAPI.openFileDialog();
  }
  return [];
}

export async function importFilesFromBrowser(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'audio/*,.mp3,.wav,.flac,.ogg,.aac,.m4a,.aiff';
    input.onchange = () => {
      const files = input.files ? Array.from(input.files) : [];
      resolve(files);
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export function isElectronEnvironment(): boolean {
  return isElectron;
}
