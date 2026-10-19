import { expect, test, type Page } from '@playwright/test';

/**
 * Auto DJ, live: synthetic tracks, Auto on, two transitions played in real time through the
 * real audio graph while a 50 ms sampler reads the channel faders and the post-fader meters.
 * The first transition is Auto's own (at the end of the first track), in the loop style: the
 * second track's kick-only intro is held on a loop, so its deck jumps back once while it fades
 * in. The third track is only added afterwards, so Auto can't run ahead; the second transition
 * is then a plain Mix now blend capped to 16 bars in the middle of the second track, so the
 * outgoing deck is stopped with audio left to play. Offline renders miss timing bugs between the
 * scheduler and the stretcher (a stopped deck that sounds on for 100 ms, a fade that jumps back
 * up, a loop that doesn't jump); this catches them.
 */

interface DeckSample {
  playing: boolean;
  fader: number;
  level: number;
  track: string | null;
  /** Track seconds the deck is at. */
  time: number;
}

interface Sample {
  t: number;
  transitioning: boolean;
  status: string | null;
  A: DeckSample;
  B: DeckSample;
  master: number;
}

type DeckId = 'A' | 'B';

const TRACK_IDS = ['live-1', 'live-2', 'live-3'];
const TRANSITIONS_WANTED = 2;
/** A stopped deck must read below this; the meters sit after the channel fader. */
const SILENCE_DB = -40;
/**
 * The fade is monotone: a window may not read louder than the previous one by more than this.
 * Windows span several beats, so that a kick falling in one window and not the next is averaged.
 */
const FADE_RISE_TOLERANCE_DB = 3;
const FADE_WINDOW_S = 2;
/** The master never falls silent for longer than this while the set plays. */
const MAX_GAP_S = 0.3;
const GAP_DB = -45;

test.describe.configure({ mode: 'serial' });

test('two automix transitions: fades fall, stopped decks go silent, no gaps', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('djmix-library'));
  await page.goto('/');
  await page.waitForFunction(() => !!window.__djmix);

  // Intro without a kick, a body, a kick-only outro. The second track is longer, so there is
  // time between the transitions, and its intro has a kick, for the loop style to hold.
  const setup = await addTracks(page, [
    { id: TRACK_IDS[0], bodyBars: 24 },
    { id: TRACK_IDS[1], bodyBars: 64, kickIntro: true },
  ]);
  expect(setup.contextState).toBe('running');
  test.info().annotations.push({ type: 'setup', description: JSON.stringify(setup) });
  await waitForAnalysis(page, TRACK_IDS.slice(0, 2));

  await installSampler(page);

  await page.evaluate(async (first) => {
    const bridge = window.__djmix!;
    const actions = bridge.actions as {
      loadToDeck: (deck: DeckId, track: unknown) => Promise<void>;
      setMasterVolume: (v: number) => void;
      setAutomixDirection: (d: 'up' | 'down' | 'any') => void;
      setAutomixEnabled: (on: boolean) => void;
      setMixStyle: (style: 'blend' | 'loop') => void;
    };
    const track = bridge.getState().tracks.find((t) => t.id === first)!;
    await actions.loadToDeck('A', track);
    actions.setMasterVolume(0.5);
    actions.setAutomixDirection('any');
    actions.setMixStyle('loop');
    actions.setAutomixEnabled(true);
  }, TRACK_IDS[0]);

  // Transition 1: Auto's own, where the first track runs out. With no third track yet, Auto
  // then waits.
  await expect.poll(() => transitionsDone(page), { timeout: 4 * 60_000, intervals: [1000] }).toEqual({ done: 1, settled: true });

  // Transition 2: Mix now into the third track once Auto has cued it, capped to 16 bars so the
  // blend ends well before the second track does.
  await addTracks(page, [{ id: TRACK_IDS[2], bodyBars: 24 }]);
  await waitForAnalysis(page, [TRACK_IDS[2]]);
  await expect
    .poll(
      () =>
        page.evaluate((third) => {
          const s = window.__djmix!.getState();
          const idle = s.deckA.playback.isPlaying ? s.deckB : s.deckA;
          return idle.track?.id === third && !!idle.track.analysis;
        }, TRACK_IDS[2]),
      { timeout: 60_000, intervals: [500] },
    )
    .toBe(true);
  await page.evaluate(() => (window.__djmix!.actions as { setMixStyle: (style: 'blend' | 'loop') => void }).setMixStyle('blend'));
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    window.__djmix!.setPlanPolicy({ maxOverlapBars: 16 });
    (window.__djmix!.actions as { triggerAutomix: (timing: 'now' | 'end') => void }).triggerAutomix('now');
  });
  await expect.poll(() => transitionsDone(page), { timeout: 3 * 60_000, intervals: [1000] }).toEqual({ done: 2, settled: true });
  await page.evaluate(() => window.__djmix!.setPlanPolicy({}));

  const probe = await page.evaluate(() => {
    const w = window as unknown as { __probe: Sample[]; __probeTimer: number };
    clearInterval(w.__probeTimer);
    (window.__djmix!.actions as { setAutomixEnabled: (on: boolean) => void }).setAutomixEnabled(false);
    return w.__probe;
  });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(test.info().outputPath('probe.json'), JSON.stringify(probe));

  const report: string[] = [];
  const transitions = findTransitions(probe);
  expect(transitions).toHaveLength(TRANSITIONS_WANTED);

  for (const [n, { start, end }] of transitions.entries()) {
    const outgoing = outgoingDeck(probe, start, end);
    const incoming: DeckId = outgoing === 'A' ? 'B' : 'A';
    const fadeStart = probe.findIndex((s, i) => i >= start && s[outgoing].fader < 0.95);
    const stop = stopIndex(probe, outgoing, fadeStart < 0 ? start : fadeStart, end);
    const stopTime = probe[stop].t;
    const line = [`transition ${n + 1}: ${outgoing} → ${incoming}`, `overlap ${(probe[end].t - probe[start].t).toFixed(1)} s`];
    // The plan as it ran ("Mixing soon → …" is set when the transition starts).
    const statuses = probe.slice(start, end).map((s) => s.status ?? '');
    const plan = statuses.find((status) => status.startsWith('Mixing soon')) ?? statuses.find((status) => status.startsWith('Mixing'));
    if (plan) line.push(plan);

    // 0. The loop mix: the incoming deck jumps back by its looped intro (8 bars) once per repeat
    // ("its bars 1–8 played 3×": twice).
    const jumps: number[] = [];
    for (let i = start + 1; i <= end; i++) {
      const back = probe[i - 1][incoming].time - probe[i][incoming].time;
      if (probe[i - 1][incoming].playing && back > 1) jumps.push(back);
    }
    line.push(`incoming jumps back ${jumps.map((s) => `${s.toFixed(1)} s`).join(', ') || 'never'}`);
    if (n === 0) {
      const plays = Number(/played (\d)×/.exec(plan ?? '')?.[1] ?? 0);
      expect.soft(plays, 'transition 1 is a loop mix').toBeGreaterThan(1);
      expect.soft(jumps, 'the incoming deck jumps back once per repeat').toHaveLength(plays - 1);
      // 8 bars at 128 BPM, less the 50 ms the deck moved on between two samples.
      for (const back of jumps) expect.soft(back, 'by its looped intro').toBeCloseTo((8 * 4 * 60) / 128, 0);
    } else {
      expect.soft(jumps, `no jump in transition ${n + 1}`).toEqual([]);
    }

    // 1. The stopped deck is silent at once and stays silent.
    const after = probe.filter((s) => s.t >= stopTime + 0.06 && s.t <= stopTime + 2);
    const loudest = Math.max(...after.map((s) => s[outgoing].level));
    line.push(`after stop max ${loudest.toFixed(1)} dBFS`);
    expect.soft(after.length, 'samples after the stop').toBeGreaterThan(20);
    expect.soft(loudest, `deck ${outgoing} after its stop (transition ${n + 1})`).toBeLessThan(SILENCE_DB);

    // 2. The fade only ever falls: no 500 ms window louder than the one before it.
    if (fadeStart >= 0 && fadeStart < stop) {
      const windows = windowMaxima(probe, outgoing, fadeStart, stop, FADE_WINDOW_S);
      const rises = windows.slice(1).map((w, i) => w - windows[i]);
      const worst = rises.length ? Math.max(...rises) : -Infinity;
      line.push(`fade ${(probe[stop].t - probe[fadeStart].t).toFixed(1)} s, ${windows.length} windows, worst rise ${worst.toFixed(1)} dB`);
      expect
        .soft(worst, `fade of deck ${outgoing} rising (transition ${n + 1}): ${windows.map((w) => w.toFixed(0)).join(' ')}`)
        .toBeLessThan(FADE_RISE_TOLERANCE_DB);
    } else {
      line.push('cut (no fade)');
    }

    // 3. Afterwards only the incoming deck plays.
    const settled = probe.find((s) => s.t >= probe[end].t + 1)!;
    expect.soft(settled[incoming].playing, `deck ${incoming} playing after transition ${n + 1}`).toBe(true);
    expect.soft(settled[outgoing].playing, `deck ${outgoing} stopped after transition ${n + 1}`).toBe(false);
    report.push(line.join(' · '));
  }

  // 4. The master never drops out while the set plays.
  const firstSound = probe.findIndex((s) => s.master > GAP_DB);
  const gap = longestGap(probe.slice(firstSound), GAP_DB);
  report.push(`longest master gap ${gap.toFixed(2)} s over ${(probe[probe.length - 1].t - probe[firstSound].t).toFixed(0)} s`);
  expect.soft(gap, 'master silence').toBeLessThan(MAX_GAP_S);

  for (const line of report) test.info().annotations.push({ type: 'measured', description: line });
  console.log(report.join('\n'));
});

/** Transitions the store has reported finished, and whether the last one ended over 3 s ago. */
function transitionsDone(page: Page): Promise<{ done: number; settled: boolean }> {
  return page.evaluate(() => {
    const probe = (window as unknown as { __probe: Sample[] }).__probe;
    let done = 0;
    let last = -Infinity;
    for (let i = 1; i < probe.length; i++) {
      if (probe[i - 1].transitioning && !probe[i].transitioning) {
        done++;
        last = probe[i].t;
      }
    }
    const t = probe.length ? probe[probe.length - 1].t : 0;
    return { done, settled: t - last > 3 };
  });
}

interface TrackSpec {
  id: string;
  bodyBars: number;
  /** A kick (no bassline) in the intro: the loop style holds it on a loop. */
  kickIntro?: boolean;
}

/** Synthesises the tracks in the page (8-bar intro, body, 8-bar kick-only outro) and adds them. */
function addTracks(page: Page, specs: TrackSpec[]): Promise<{ contextState: string; sampleRate: number; durations: number[] }> {
  return page.evaluate(async (specs: TrackSpec[]) => {
    const bridge = window.__djmix!;
    const actions = bridge.actions as { addTracks: (tracks: unknown[]) => void };
    // A test-only module, fetched through Vite; a variable keeps the type checker out of it.
    const synthUrl = '/src/audio/analysis/syntheticTrack.ts';
    const { synthesizeTrack } = (await import(synthUrl)) as typeof import('../src/audio/analysis/syntheticTrack');
    const ctx = bridge.getAudioContext();
    await ctx.resume();
    const make = ({ id, bodyBars, kickIntro }: TrackSpec) => {
      const synth = synthesizeTrack({
        bpm: 128,
        firstDownbeat: 0.25,
        sections: [
          kickIntro ? { bars: 8, kick: true, hats: true, chords: true } : { bars: 8, hats: true, chords: true },
          { bars: bodyBars, kick: true, bass: true, hats: true, clap: true },
          { bars: 8, kick: true, hats: true },
        ],
        sampleRate: ctx.sampleRate,
      });
      const buffer = ctx.createBuffer(2, synth.channels[0].length, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const out = buffer.getChannelData(c);
        const src = synth.channels[c];
        for (let i = 0; i < src.length; i++) out[i] = src[i] * 0.5;
      }
      return {
        id,
        filePath: `${id}.wav`,
        fileName: `${id}.wav`,
        duration: buffer.duration,
        fileSize: 1,
        analysis: null,
        analysisStatus: 'pending',
        _audioBuffer: buffer,
      };
    };
    const tracks = specs.map(make);
    actions.addTracks(tracks);
    return { contextState: ctx.state, sampleRate: ctx.sampleRate, durations: tracks.map((t) => t.duration) };
  }, specs);
}

async function waitForAnalysis(page: Page, ids: string[]): Promise<void> {
  await expect
    .poll(() => page.evaluate((ids: string[]) => ids.map((id) => window.__djmix!.getState().tracks.find((t) => t.id === id)?.analysisStatus), ids), {
      timeout: 180_000,
      intervals: [1000],
    })
    .toEqual(ids.map(() => 'complete'));
}

async function installSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bridge = window.__djmix!;
    const graph = bridge.getMixGraph();
    const meters = { A: bridge.getMeter('A'), B: bridge.getMeter('B'), master: bridge.getMeter('master') };
    const buffer = new Float32Array(1024);
    const level = (analyser: AnalyserNode): number => {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
      const rms = Math.sqrt(sum / buffer.length);
      return rms > 0 ? 20 * Math.log10(rms) : -120;
    };
    const probe: Sample[] = [];
    const w = window as unknown as { __probe: Sample[]; __probeTimer: number };
    w.__probe = probe;
    w.__probeTimer = window.setInterval(() => {
      const state = bridge.getState();
      const deck = (id: DeckId): DeckSample => {
        const d = id === 'A' ? state.deckA : state.deckB;
        return {
          playing: d.playback.isPlaying,
          fader: graph.decks[id].fader.gain.value,
          level: level(meters[id]),
          track: d.track?.id ?? null,
          time: d.playback.currentTime,
        };
      };
      probe.push({
        t: graph.ctx.currentTime,
        transitioning: state.automix.isTransitioning,
        status: state.automix.status,
        A: deck('A'),
        B: deck('B'),
        master: level(meters.master),
      });
    }, 50);
  });
}

/** Index ranges where the store reports a transition in progress. */
function findTransitions(probe: Sample[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = -1;
  probe.forEach((s, i) => {
    if (s.transitioning && start < 0) start = i;
    if (!s.transitioning && start >= 0) {
      out.push({ start, end: i });
      start = -1;
    }
  });
  return out;
}

/** The deck that was playing when the transition began and is not when it ended. */
function outgoingDeck(probe: Sample[], start: number, end: number): DeckId {
  const stopped = (['A', 'B'] as const).filter((id) => probe[start][id].playing && !probe[end][id].playing);
  if (stopped.length === 1) return stopped[0];
  // Both still flagged (or neither): the one whose fader went down.
  const minFader = (id: DeckId) => Math.min(...probe.slice(start, end + 1).map((s) => s[id].fader));
  return minFader('A') < minFader('B') ? 'A' : 'B';
}

/**
 * When the outgoing deck was stopped: the runner resets its fader to neutral right after the
 * pause, so the fader coming back up after the fade marks the moment within one sample; the
 * store's playing flag is the fallback.
 */
function stopIndex(probe: Sample[], deck: DeckId, from: number, end: number): number {
  let faded = false;
  for (let i = from; i < probe.length; i++) {
    const fader = probe[i][deck].fader;
    if (fader < 0.2) faded = true;
    if (faded && fader > 0.5) return i;
    if (i > end + 60) break;
  }
  const flag = probe.findIndex((s, i) => i >= from && !s[deck].playing);
  return flag >= 0 ? flag : end;
}

function windowMaxima(probe: Sample[], deck: DeckId, from: number, to: number, windowSeconds: number): number[] {
  const maxima: number[] = [];
  let windowStart = probe[from].t;
  let max = -Infinity;
  for (let i = from; i < to; i++) {
    const s = probe[i];
    if (s.t - windowStart >= windowSeconds) {
      maxima.push(max);
      windowStart += windowSeconds;
      max = -Infinity;
    }
    max = Math.max(max, s[deck].level);
  }
  return maxima;
}

function longestGap(samples: Sample[], thresholdDb: number): number {
  let longest = 0;
  let gapStart: number | null = null;
  for (const s of samples) {
    if (s.master < thresholdDb) {
      gapStart ??= s.t;
      longest = Math.max(longest, s.t - gapStart);
    } else {
      gapStart = null;
    }
  }
  return longest;
}
