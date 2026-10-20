import { describe, expect, it } from 'vitest';
import { choosePhraseLines } from './structure';

/** Novelty for `bars` bars: a small in-phrase wobble everywhere, `peaks` (bar → strength) on top. */
function novelty(bars: number, peaks: Record<number, number>): number[] {
  return Array.from({ length: bars }, (_, bar) => peaks[bar] ?? 0.1 + 0.05 * (bar % 3));
}

describe('choosePhraseLines', () => {
  it('lays an 8-bar grid through the boundaries', () => {
    const lines = choosePhraseLines(novelty(64, { 16: 3, 32: 3, 48: 2 }), 64);
    expect(lines).toEqual([0, 8, 16, 24, 32, 40, 48, 56]);
  });

  it('starts the grid after a pickup when the boundaries sit off bar 0', () => {
    const lines = choosePhraseLines(novelty(66, { 10: 3, 26: 3, 42: 3 }), 66);
    expect(lines).toEqual([0, 2, 10, 18, 26, 34, 42, 50, 58]);
  });

  it('moves the grid through a 4-bar break when the boundaries after it are strong', () => {
    // Sections at 8, 16, 24, then a 4-bar break: 28, 36, 44, 52 on the moved grid.
    const lines = choosePhraseLines(novelty(72, { 8: 3, 16: 3, 24: 3, 28: 3, 36: 3, 44: 3, 52: 3 }), 72);
    expect(lines).toEqual([0, 8, 16, 24, 28, 36, 44, 52, 60, 68]);
  });

  it('keeps the grid through a weak off-grid change', () => {
    const lines = choosePhraseLines(novelty(64, { 8: 3, 16: 3, 24: 3, 30: 0.8, 40: 3 }), 64);
    expect(lines.every((bar) => bar % 8 === 0)).toBe(true);
  });

  it("doesn't align the grid to where the file ends", () => {
    // Weak boundaries on the bar-2 grid; the fade at the end (bar 64) is the biggest change.
    const lines = choosePhraseLines(novelty(70, { 10: 1.5, 26: 1.5, 42: 1.5, 64: 20 }), 70);
    expect(lines[1]).toBe(2);
  });

  it('ignores the changes of a fade-in from silence', () => {
    const audible = Array.from({ length: 66 }, (_, bar) => bar >= 4);
    const lines = choosePhraseLines(novelty(66, { 1: 15, 3: 15, 10: 3, 26: 3, 42: 3 }), 66, audible);
    expect(lines[1]).toBe(2);
  });
});
