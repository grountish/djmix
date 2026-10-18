/**
 * Runs the track analyzer on audio files and prints a summary table.
 *
 *   npm run analyze -- <file|folder>... [--json out.json]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';
import { parseFile } from 'music-metadata';
import { OfflineAudioContext } from 'node-web-audio-api';
import { analyzeAudio } from '../src/audio/analysis/analyzeAudio';
import { keyFromTag } from '../src/audio/analysis/key';
import type { AudioAnalysis } from '../src/audio/analysis/types';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.aiff', '.aif']);

function collectFiles(paths: string[]): string[] {
  return paths.flatMap((path) => {
    if (statSync(path).isDirectory()) {
      return readdirSync(path)
        .sort()
        .map((name) => join(path, name))
        .filter((file) => AUDIO_EXTENSIONS.has(extname(file).toLowerCase()));
    }
    return [path];
  });
}

async function decode(file: string): Promise<AudioBuffer> {
  const data = readFileSync(file);
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 44100 });
  return ctx.decodeAudioData(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

function summarizePhrases(analysis: AudioAnalysis): string {
  const short = { intro: 'In', build: 'Bu', drop: 'Dr', breakdown: 'Bd', outro: 'Out' } as const;
  return analysis.phrases.map((p) => `${short[p.label]}${p.bars}`).join(' ');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonIndex = args.indexOf('--json');
  const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1] : null;
  const inputs = args.filter((_, i) => jsonIndex < 0 || (i !== jsonIndex && i !== jsonIndex + 1));
  const files = collectFiles(inputs);
  const results: Record<string, AudioAnalysis> = {};

  console.log(
    ['track'.padEnd(36), 'bpm'.padStart(8), 'tagBpm', 'conf', 'grid', 'resid', 'beat1'.padStart(6), 'dbc', 'key', 'tagKey', 'LUFS'.padStart(6), 'TP'.padStart(5), 'ms'.padStart(5), 'phrases'].join(' '),
  );
  for (const file of files) {
    try {
      const buffer = await decode(file);
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
      const tags = (await parseFile(file, { skipCovers: true })).common;
      const started = Date.now();
      const analysis = analyzeAudio(channels, buffer.sampleRate, { bpm: tags.bpm });
      const elapsed = Date.now() - started;
      const tagKey = keyFromTag(tags.key as string | undefined)?.camelot ?? '-';
      results[basename(file)] = analysis;
      console.log(
        [
          basename(file, extname(file)).slice(0, 36).padEnd(36),
          analysis.bpm.toFixed(3).padStart(8),
          String(tags.bpm ?? '-').padStart(6),
          analysis.bpmConfidence.toFixed(2),
          analysis.tempo.isConstant ? 'const' : 'VAR  ',
          analysis.tempo.residualMs.toFixed(1).padStart(5),
          analysis.firstBeatTime.toFixed(3).padStart(6),
          analysis.downbeatConfidence.toFixed(2),
          analysis.key.camelot.padStart(3),
          tagKey.padStart(6),
          analysis.loudness.integratedLufs.toFixed(1).padStart(6),
          analysis.loudness.truePeakDb.toFixed(1).padStart(5),
          String(elapsed).padStart(5),
          summarizePhrases(analysis),
        ].join(' '),
      );
    } catch (error) {
      console.log(`${basename(file).padEnd(36)} FAILED: ${(error as Error).message}`);
    }
  }

  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(results, null, 2));
}

main();
