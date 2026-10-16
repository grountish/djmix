import { describe, expect, it } from 'vitest';
import { planTempo } from './tempoPlan';

describe('planTempo', () => {
  it('meets halfway so neither track strays far from its own tempo', () => {
    const plan = planTempo(100, 1, 110);
    expect(plan.canBlend).toBe(true);
    expect(plan.meetBpm).toBeCloseTo(Math.sqrt(100 * 110), 9);
    expect(plan.outgoingRate).toBeCloseTo(1.0488, 4);
    expect(plan.incomingRate).toBeCloseTo(0.9535, 4);
    // ~4.9% at 0.5% per bar
    expect(plan.outgoingRampBars).toBe(10);
    expect(plan.incomingRampBars).toBe(10);
  });

  it('lets only the incoming track adjust for small gaps', () => {
    const plan = planTempo(124, 1, 125);
    expect(plan.meetBpm).toBe(124);
    expect(plan.outgoingRate).toBe(1);
    expect(plan.outgoingRampBars).toBe(0);
    expect(plan.incomingRate).toBeCloseTo(124 / 125, 12);
  });

  it('blends up to about 21% apart and cuts beyond', () => {
    expect(planTempo(100, 1, 121).canBlend).toBe(true);
    expect(planTempo(100, 1, 128).canBlend).toBe(false);
  });

  it('ramps the outgoing track from where it currently plays', () => {
    // Still 5% fast from its own intro ramp: it eases back towards the meeting tempo.
    const plan = planTempo(120, 1.05, 126);
    expect(plan.outgoingRate).toBeCloseTo(Math.sqrt(126 / 120), 12);
    expect(plan.outgoingRampBars).toBe(5);
  });
});
