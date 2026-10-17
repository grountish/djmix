/**
 * Renders every transition of a set offline and tabulates the metrics, so a change to the
 * analyser or the planner can be judged on the whole library rather than on one pair.
 *
 *   npm run mixset -- <folder|file...> [--order folder|smart] [--out mixset-out] [--limit N]
 *                     [--no-balance] [--wav] [--pairs "a>b;c>d"]
 *
 * Analyses are cached in <out>/analysis-cache.json keyed by file, size and analyser version.
 * Writes <out>/report.json and <out>/report.md and prints the table. A row is flagged when
 * the grid-based and the grid-free timing disagree, when a blend measures a hole or stacking,
 * when the beat clocks disagreed, or when the pair fell back to a cut.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';
import { ANALYZER_VERSION, type AudioAnalysis } from '../src/audio/analysis/types';
import { orderSet, sequencerTrackFromAnalysis } from '../src/audio/mix/sequencer';
import { parseArgs } from './mixlab';
import { loadTrack, type LoadedTrack, type PairReport, renderTransition } from './mixlabLib';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.aiff', '.aif']);
/** Grid-based (median) and grid-free offsets further apart than this disagree. */
const TIMING_DISAGREEMENT_MS = 8;

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

interface CachedEntry {
  size: number;
  analyzerVersion: number;
  analysis: AudioAnalysis;
}

class AnalysisCache {
  private entries: Record<string, CachedEntry> = {};
  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        this.entries = JSON.parse(readFileSync(path, 'utf-8'));
      } catch {
        this.entries = {};
      }
    }
  }
  get(file: string): AudioAnalysis | undefined {
    const entry = this.entries[file];
    const size = statSync(file).size;
    return entry && entry.size === size && entry.analyzerVersion === ANALYZER_VERSION ? entry.analysis : undefined;
  }
  set(file: string, analysis: AudioAnalysis): void {
    this.entries[file] = { size: statSync(file).size, analyzerVersion: ANALYZER_VERSION, analysis };
    writeFileSync(this.path, JSON.stringify(this.entries));
  }
}

export interface SetRow extends PairReport {
  index: number;
  flags: string[];
  error?: string;
}

/** What deserves a listen: disagreements between measures, holes, stacking, lost locks, cuts. */
export function flagsFor(report: PairReport): string[] {
  const flags: string[] = [];
  if (report.kind === 'cut') flags.push('cut');
  if (report.lockAbandoned) flags.push('lock-abandoned');
  if (report.warnings.some((w) => /downbeat/i.test(w))) flags.push('downbeat?');
  const grid = report.beatAlignmentMs;
  const phase = report.kickPhase;
  if (grid && grid.beats > 0 && phase && Number.isFinite(phase.offsetMs)) {
    if (Math.abs(phase.offsetMs - grid.median) > TIMING_DISAGREEMENT_MS) flags.push('timing-disagree');
  } else if (report.kind === 'blend' && grid && grid.beats < 8) {
    flags.push('few-kicks');
  }
  if (phase && Number.isFinite(phase.offsetMs)) {
    const halfPeriodMs = (60000 / report.meetBpm) / 2;
    if (Math.abs(Math.abs(phase.offsetMs) - halfPeriodMs) < 25) flags.push('half-beat?');
  }
  if (report.forecast) {
    if (report.forecast.measuredHoleDb > 6) flags.push(`hole ${report.forecast.measuredHoleDb.toFixed(1)} dB`);
    if (report.forecast.measuredExcessDb > 3) flags.push(`stack ${report.forecast.measuredExcessDb.toFixed(1)} dB`);
  }
  if (report.lowBandCollisions && report.lowBandCollisions.length > 0) flags.push(`collisions ${report.lowBandCollisions.length}`);
  if (report.masterPeakDb > -1) flags.push('peak');
  return flags;
}

function cell(value: number | undefined, digits = 1): string {
  return value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits);
}

export function markdownTable(rows: SetRow[]): string {
  const header = ['#', 'outgoing → incoming', 'kind', 'bars', 'BPM', 'grid p95', 'phase', 'corr', 'hole', 'stack', 'fc err', 'LU', 'peak', 'flags'];
  const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`];
  for (const row of rows) {
    if (row.error) {
      lines.push(`| ${row.index} | ${row.outgoing} → ${row.incoming} | error | | | | | | | | | | | ${row.error} |`);
      continue;
    }
    lines.push(
      `| ${row.index} | ${row.outgoing} → ${row.incoming} | ${row.kind} | ${row.overlapBars} | ${row.meetBpm.toFixed(1)} | ${cell(row.beatAlignmentMs?.p95)} (${row.beatAlignmentMs?.beats ?? 0}) | ${cell(row.kickPhase?.offsetMs)} | ${cell(row.kickPhase?.correlation, 2)} | ${cell(row.forecast?.measuredHoleDb)} | ${cell(row.forecast?.measuredExcessDb)} | ${cell(row.forecast?.rmsErrorDb)} | ${cell(row.loudnessDeviationLu)} | ${cell(row.masterPeakDb)} | ${row.flags.join(', ')} |`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { files: inputs, options } = parseArgs(
    process.argv.slice(2),
    ['--order', '--out', '--limit', '--pairs'],
    ['--no-balance', '--wav'],
  );
  const outDir = (options.get('--out') as string | undefined) ?? 'mixset-out';
  const order = (options.get('--order') as string | undefined) ?? 'folder';
  const limit = options.has('--limit') ? Number(options.get('--limit')) : Infinity;
  const policy = { balance: !options.has('--no-balance') };
  const files = collectFiles(inputs);
  if (files.length < 2) throw new Error('mixset needs at least two audio files');
  mkdirSync(outDir, { recursive: true });
  const cache = new AnalysisCache(join(outDir, 'analysis-cache.json'));

  const tracks = new Map<string, LoadedTrack>();
  const load = async (file: string) => {
    let track = tracks.get(file);
    if (!track) {
      const cached = cache.get(file);
      track = await loadTrack(file, cached);
      if (!cached) cache.set(file, track.analysis);
      tracks.set(file, track);
    }
    return track;
  };

  // The pairs: explicit, the folder order, or the sequencer's smart order. Names compare
  // composed (macOS hands out decomposed file names: "Pantalón" is two code points there).
  let pairs: [string, string][] = [];
  const key = (s: string) => s.normalize('NFC').toLowerCase();
  const byName = new Map(files.map((file) => [key(basename(file, extname(file))), file]));
  if (options.has('--pairs')) {
    for (const spec of String(options.get('--pairs')).split(';')) {
      const [a, b] = spec.split('>').map((s) => key(s.trim()));
      const fileA = byName.get(a) ?? files.find((f) => key(basename(f)).includes(a));
      const fileB = byName.get(b) ?? files.find((f) => key(basename(f)).includes(b));
      if (!fileA || !fileB) throw new Error(`pair not found: ${spec}`);
      pairs.push([fileA, fileB]);
    }
  } else {
    let ordered = files;
    if (order === 'smart') {
      console.error(`analysing ${files.length} tracks for the smart order…`);
      const loaded = await Promise.all(files.map(load));
      const set = orderSet(loaded.map((t) => sequencerTrackFromAnalysis(t.file, t.analysis)));
      ordered = set.tracks.map((t) => t.id);
    }
    for (let i = 0; i + 1 < ordered.length; i++) pairs.push([ordered[i], ordered[i + 1]]);
  }
  pairs = pairs.slice(0, limit);

  const rows: SetRow[] = [];
  for (const [index, [fileA, fileB]] of pairs.entries()) {
    const label = `${basename(fileA)} → ${basename(fileB)}`;
    console.error(`[${index + 1}/${pairs.length}] ${label}`);
    try {
      const outgoing = await load(fileA);
      const incoming = await load(fileB);
      const wavPath = options.has('--wav') ? join(outDir, `${String(index + 1).padStart(2, '0')} ${basename(fileA, extname(fileA))} to ${basename(fileB, extname(fileB))}.wav`) : undefined;
      const { report } = await renderTransition(outgoing, incoming, { policy, wavPath });
      rows.push({ ...report, index: index + 1, flags: flagsFor(report) });
    } catch (error) {
      rows.push({
        index: index + 1,
        outgoing: basename(fileA),
        incoming: basename(fileB),
        plan: '',
        kind: 'cut',
        overlapBars: 0,
        meetBpm: 0,
        warnings: [],
        lockAbandoned: false,
        seconds: 0,
        masterPeakDb: NaN,
        flags: ['error'],
        error: (error as Error).message,
      });
    }
    writeFileSync(join(outDir, 'report.json'), JSON.stringify(rows, null, 2));
    writeFileSync(join(outDir, 'report.md'), `${markdownTable(rows)}\n`);
  }

  const table = markdownTable(rows);
  console.log(table);
  const blends = rows.filter((r) => !r.error && r.kind === 'blend');
  const flagged = rows.filter((r) => r.flags.length > 0);
  console.log(
    `\n${rows.length} transitions, ${blends.length} blends, ${rows.filter((r) => r.pass).length} pass every check, ${flagged.length} flagged. Reports in ${outDir}/.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
