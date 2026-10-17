/**
 * Renders an automix transition between two audio files offline, writes it to a WAV and
 * prints how tight it was.
 *
 *   npm run mixlab -- <outgoing> <incoming> [--out mix.wav] [--no-balance] [--json report.json]
 *
 * MIXLAB_DEBUG=1 prints the aligned beats, the loudness curve and the forecast / measured
 * band rows.
 */
import { writeFileSync } from 'fs';
import { loadTrack, printDebug, renderTransition } from './mixlabLib';

/** Command line: positional files plus `--flag value` options and bare `--switch` flags. */
export function parseArgs(
  argv: string[],
  valued: string[],
  switches: string[],
): { files: string[]; options: Map<string, string | true> } {
  const files: string[] = [];
  const options = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (valued.includes(arg)) options.set(arg, argv[++i]);
    else if (switches.includes(arg)) options.set(arg, true);
    else files.push(arg);
  }
  return { files, options };
}

async function main(): Promise<void> {
  const { files, options } = parseArgs(process.argv.slice(2), ['--out', '--json'], ['--no-balance']);
  const wavPath = (options.get('--out') as string | undefined) ?? 'mixlab.wav';
  const jsonPath = options.get('--json') as string | undefined;
  const [outgoingFile, incomingFile] = files;
  if (!outgoingFile || !incomingFile) {
    throw new Error('Usage: mixlab <outgoing> <incoming> [--out mix.wav] [--no-balance] [--json report.json]');
  }

  const outgoing = await loadTrack(outgoingFile);
  const incoming = await loadTrack(incomingFile);
  const result = await renderTransition(outgoing, incoming, {
    policy: { balance: !options.has('--no-balance') },
    wavPath,
  });
  console.log(result.report.plan);
  if (process.env.MIXLAB_DEBUG) printDebug(result);
  console.log(JSON.stringify({ ...result.report, wav: wavPath }, null, 2));
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify({ ...result.report, wav: wavPath, plan: result.plan }, null, 2));
}

if (process.argv[1] && /mixlab\.ts$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
