/**
 * Runs the track analyzer on audio files and prints a summary table; with a baseline, also
 * what changed since it was written, how the results agree with the files' tags, and which
 * of the user's in-app corrections the analyser still needs.
 *
 *   npm run analyze -- <file|folder>... [--json out.json]
 *                      [--baseline fixtures/analysis-baseline.json] [--update]
 *                      [--library "~/Library/Application Support/djmix/track-library.json"]
 *
 * Exits 1 when a baseline is given, --update is not, and any track changed.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';
import { parseFile } from 'music-metadata';
import { OfflineAudioContext } from 'node-web-audio-api';
import { analyzeAudio } from '../src/audio/analysis/analyzeAudio';
import { keyFromTag } from '../src/audio/analysis/key';
import type { AnalysisOverrides, AudioAnalysis } from '../src/audio/analysis/types';
import {
  compareToBaseline,
  correctionStatus,
  summarizePhrases,
  summarizeTrack,
  tagAgreement,
  type TrackSummary,
} from './analyzeCheck';
import { parseArgs } from './mixlab';

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

/** The app's saved library, for the corrections the user made per file name. */
function loadOverrides(libraryPath: string): Map<string, AnalysisOverrides> {
  const overrides = new Map<string, AnalysisOverrides>();
  if (!existsSync(libraryPath)) {
    console.error(`library not found: ${libraryPath}`);
    return overrides;
  }
  const tracks = JSON.parse(readFileSync(libraryPath, 'utf-8')) as { fileName: string; overrides?: AnalysisOverrides }[];
  for (const track of tracks) if (track.overrides) overrides.set(track.fileName.normalize('NFC'), track.overrides);
  return overrides;
}

async function main(): Promise<void> {
  const { files: inputs, options } = parseArgs(process.argv.slice(2), ['--json', '--baseline', '--library'], ['--update']);
  const jsonPath = options.get('--json') as string | undefined;
  const baselinePath = options.get('--baseline') as string | undefined;
  const libraryPath = options.get('--library') as string | undefined;
  const files = collectFiles(inputs);
  const results: Record<string, AudioAnalysis> = {};
  const summaries: Record<string, TrackSummary> = {};
  const baseline: Record<string, TrackSummary> =
    baselinePath && existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf-8')) : {};
  const overrides = libraryPath ? loadOverrides(libraryPath.replace(/^~/, process.env.HOME ?? '~')) : new Map<string, AnalysisOverrides>();
  const changes: { name: string; changes: string[] }[] = [];
  const corrections: { name: string; remaining: string[] }[] = [];
  const tags = { tempoSame: 0, tempoOctave: 0, tempoRatio: 0, tempoOther: 0, keySame: 0, keyRelative: 0, keyOther: 0 };

  console.log(
    ['track'.padEnd(36), 'bpm'.padStart(8), 'tagBpm', 'conf', 'grid', 'resid', 'beat1'.padStart(6), 'dbc', 'key', 'tagKey', 'LUFS'.padStart(6), 'TP'.padStart(5), 'ms'.padStart(5), 'phrases'].join(' '),
  );
  for (const file of files) {
    const name = basename(file).normalize('NFC');
    try {
      const buffer = await decode(file);
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
      const fileTags = (await parseFile(file, { skipCovers: true })).common;
      const started = Date.now();
      const analysis = analyzeAudio(channels, buffer.sampleRate, { bpm: fileTags.bpm });
      const elapsed = Date.now() - started;
      const tagKey = keyFromTag(fileTags.key as string | undefined)?.camelot;
      results[name] = analysis;
      const summary = summarizeTrack(analysis, { bpm: fileTags.bpm, key: tagKey });
      summaries[name] = summary;
      const agreement = tagAgreement(summary, analysis.key.camelot);
      if (agreement.tempo !== 'untagged') tags[`tempo${agreement.tempo[0].toUpperCase()}${agreement.tempo.slice(1)}` as keyof typeof tags]++;
      if (agreement.key !== 'untagged') tags[`key${agreement.key[0].toUpperCase()}${agreement.key.slice(1)}` as keyof typeof tags]++;
      if (baselinePath) {
        const change = compareToBaseline(name, baseline[name], summary);
        if (change.changes.length > 0) changes.push(change);
      }
      const correction = overrides.get(name);
      if (correction) corrections.push(correctionStatus(name, analysis, correction));
      console.log(
        [
          basename(file, extname(file)).slice(0, 36).padEnd(36),
          analysis.bpm.toFixed(3).padStart(8),
          String(fileTags.bpm ?? '-').padStart(6),
          analysis.bpmConfidence.toFixed(2),
          analysis.tempo.isConstant ? 'const' : 'VAR  ',
          analysis.tempo.residualMs.toFixed(1).padStart(5),
          analysis.firstBeatTime.toFixed(3).padStart(6),
          analysis.downbeatConfidence.toFixed(2),
          analysis.key.camelot.padStart(3),
          (tagKey ?? '-').padStart(6),
          analysis.loudness.integratedLufs.toFixed(1).padStart(6),
          analysis.loudness.truePeakDb.toFixed(1).padStart(5),
          String(elapsed).padStart(5),
          summarizePhrases(analysis),
        ].join(' '),
      );
    } catch (error) {
      console.log(`${name.padEnd(36)} FAILED: ${(error as Error).message}`);
    }
  }

  const n = Object.keys(summaries).length;
  console.log(
    `\n${n} tracks. Tempo vs tag: ${tags.tempoSame} same, ${tags.tempoOctave} octave apart, ${tags.tempoRatio} at 3:2/4:3, ${tags.tempoOther} other. ` +
      `Key vs tag: ${tags.keySame} same, ${tags.keyRelative} relative/neighbour, ${tags.keyOther} other.`,
  );
  if (corrections.length > 0) {
    const open = corrections.filter((c) => c.remaining.length > 0);
    console.log(`\nUser corrections in the library: ${corrections.length}; the analyser still disagrees on ${open.length}:`);
    for (const c of open) console.log(`  ${c.name}: ${c.remaining.join(', ')}`);
    for (const c of corrections.filter((x) => x.remaining.length === 0)) console.log(`  ${c.name}: now agrees (correction redundant)`);
  }
  if (baselinePath) {
    if (Object.keys(baseline).length === 0) console.log(`\nNo baseline at ${baselinePath} yet.`);
    else if (changes.length === 0) console.log(`\nNo changes against ${baselinePath}.`);
    else {
      console.log(`\n${changes.length} track(s) changed against ${baselinePath}:`);
      for (const change of changes) console.log(`  ${change.name}: ${change.changes.join(', ')}`);
    }
    if (options.has('--update')) {
      writeFileSync(baselinePath, `${JSON.stringify(summaries, null, 2)}\n`);
      console.log(`Baseline written: ${baselinePath}`);
    } else if (changes.length > 0 && Object.keys(baseline).length > 0) {
      process.exitCode = 1;
    }
  }
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
