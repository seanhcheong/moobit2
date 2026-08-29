import {
  DEFAULT_DEPTH_FSM,
  createDepthFsmState,
  stepDepthFsm,
  toContractPhase,
  type DepthFsmConfig,
  type DepthFsmState,
} from '../src/core/depthFsm';

const cfg: DepthFsmConfig = { ...DEFAULT_DEPTH_FSM };

/** Drive the machine along a depth curve at 30 fps, returning what happened. */
function drive(
  s: DepthFsmState,
  depths: number[],
  startMs = 0,
  fps = 30,
): { phases: string[]; reps: number; partials: number } {
  const dt = 1000 / fps;
  const phases: string[] = [];
  let reps = 0;
  let partials = 0;
  let prev = depths.length > 0 ? depths[0] : 0;
  for (let i = 0; i < depths.length; i++) {
    const nowMs = startMs + i * dt;
    const d = depths[i];
    const vel = ((d - prev) / dt) * 1000;
    prev = d;
    const r = stepDepthFsm(s, cfg, d, vel, nowMs);
    if (phases.length === 0 || phases[phases.length - 1] !== r.phase) phases.push(r.phase);
    if (r.repCompleted) reps++;
    if (r.partialRejected) partials++;
  }
  return { phases, reps, partials };
}

/** A smooth up-and-down depth curve, like one rep. */
function repCurve(peak: number, frames: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < frames; i++) {
    const t = i / (frames - 1);
    // Sine gives a smooth, monotonic rise and fall with zero velocity at the ends.
    out.push(peak * Math.sin(Math.PI * t));
  }
  return out;
}

describe('the reciprocating state machine', () => {
  it('walks top -> descending -> bottom -> ascending -> top and counts one rep', () => {
    const s = createDepthFsmState();
    const r = drive(s, repCurve(95, 60));
    expect(r.phases).toEqual(['top', 'descending', 'bottom', 'ascending', 'top']);
    expect(r.reps).toBe(1);
    expect(s.repCount).toBe(1);
  });

  it('counts ten reps from ten cycles', () => {
    const s = createDepthFsmState();
    const depths: number[] = [];
    for (let i = 0; i < 10; i++) {
      depths.push(...repCurve(95, 60));
      // A pause at the top between reps.
      for (let k = 0; k < 10; k++) depths.push(0);
    }
    const r = drive(s, depths);
    expect(r.reps).toBe(10);
  });

  it('rejects a rep that reaches bottom but not minRepDepth', () => {
    // enterBottomDepth is 60 and minRepDepth is 70, so a peak of 65 must report the bottom phase
    // (the animation stream stays truthful) yet not be credited.
    const s = createDepthFsmState();
    const r = drive(s, repCurve(65, 60));
    expect(r.phases).toContain('bottom');
    expect(r.reps).toBe(0);
    expect(s.partialReps).toBe(1);
  });

  it('classifies a meaningful aborted descent as a partial, not as flicker', () => {
    // Flicker count is the signal-quality metric; partial count is the user-form metric.
    const s = createDepthFsmState();
    const r = drive(s, repCurve(45, 60));
    expect(r.reps).toBe(0);
    expect(s.partialReps).toBe(1);
    expect(s.flickers).toBe(0);
  });

  it('classifies a tiny twitch as flicker, not as a partial rep', () => {
    const s = createDepthFsmState();
    drive(s, repCurve(20, 60));
    expect(s.repCount).toBe(0);
    expect(s.partialReps).toBe(0);
    expect(s.flickers).toBe(1);
  });

  it('ignores depth below the descend threshold entirely', () => {
    const s = createDepthFsmState();
    const r = drive(s, repCurve(12, 90));
    expect(r.phases).toEqual(['top']);
    expect(s.flickers).toBe(0);
  });

  it('holds the top state across the hysteresis dead band', () => {
    // topDepth 8 and enterDescendDepth 15 leave a dead band that noise should not cross.
    const s = createDepthFsmState();
    const depths: number[] = [];
    for (let i = 0; i < 200; i++) depths.push(11 + 3 * Math.sin(i));
    const r = drive(s, depths);
    expect(r.phases).toEqual(['top']);
    expect(s.repCount).toBe(0);
  });

  it('requires a minimum descent velocity, so a slow drift does not start a rep', () => {
    const s = createDepthFsmState();
    // Ramp to 20 over 60 s: above the threshold in value, far below it in rate.
    const depths: number[] = [];
    for (let i = 0; i < 1800; i++) depths.push((20 * i) / 1800);
    const r = drive(s, depths);
    expect(r.phases).toEqual(['top']);
  });

  it('treats a wobble during the ascent as one rep, not two', () => {
    const s = createDepthFsmState();
    const depths: number[] = [];
    // Down to the bottom.
    for (let i = 0; i < 15; i++) depths.push((95 * i) / 14);
    // Clearly up into the ascending phase (below exitBottomDepth of 50)...
    for (const d of [80, 65, 48, 40, 35]) depths.push(d);
    // ...then back down past enterBottomDepth, held long enough to clear the reverse dwell.
    for (let i = 0; i < 10; i++) depths.push(70 + i);
    // And finally all the way up.
    for (let i = 0; i < 15; i++) depths.push(80 - (80 * i) / 14);
    const r = drive(s, depths);
    expect(r.reps).toBe(1);
    expect(r.phases).toEqual(['top', 'descending', 'bottom', 'ascending', 'bottom', 'ascending', 'top']);
    expect(s.flickers).toBeGreaterThanOrEqual(1);
  });

  it('abandons a rep that stalls past maxRepMs instead of wedging', () => {
    const s = createDepthFsmState();
    const depths: number[] = [];
    for (let i = 0; i < 30; i++) depths.push((95 * i) / 29);
    // Then sit at the bottom for 12 s, well past the 8 s ceiling.
    for (let i = 0; i < 360; i++) depths.push(95);
    const r = drive(s, depths);
    expect(r.reps).toBe(0);
    expect(s.abandonedReps).toBe(1);
    expect(s.phase).toBe('top');
  });

  it('recovers from tracking loss without inventing a rep', () => {
    const s = createDepthFsmState();
    // Descend to the bottom, then lose the signal entirely.
    const depths: number[] = [];
    for (let i = 0; i < 30; i++) depths.push((95 * i) / 29);
    const r1 = drive(s, depths);
    expect(r1.phases).toContain('bottom');

    // NaN depth for well over lossTimeoutMs.
    const nan: number[] = new Array(60).fill(NaN);
    drive(s, nan, 1000);
    expect(s.phase).toBe('top');
    expect(s.repCount).toBe(0);
    expect(s.trackingLosses).toBe(1);
    expect(s.abandonedReps).toBe(1);
  });

  it('holds its phase through a short signal gap rather than resetting', () => {
    const s = createDepthFsmState();
    const depths: number[] = [];
    for (let i = 0; i < 30; i++) depths.push((95 * i) / 29);
    drive(s, depths);
    expect(s.phase).toBe('bottom');

    // Six missing frames at 30 fps is 200 ms, well inside the 700 ms tolerance.
    drive(s, new Array(6).fill(NaN), 1000);
    expect(s.phase).toBe('bottom');
    expect(s.trackingLosses).toBe(0);
  });

  it('rejects an implausibly fast rep as a glitch', () => {
    const s = createDepthFsmState();
    // A full cycle in 8 frames at 30 fps is 267 ms, under the 500 ms floor.
    const r = drive(s, repCurve(95, 8));
    expect(r.reps).toBe(0);
  });
});

describe('toContractPhase', () => {
  it('maps the internal top state onto the contract`s standing', () => {
    // The output contract has no 'up', so a push-up's top has to land on 'standing'.
    expect(toContractPhase('top')).toBe('standing');
  });

  it('passes the other phases through unchanged', () => {
    expect(toContractPhase('descending')).toBe('descending');
    expect(toContractPhase('bottom')).toBe('bottom');
    expect(toContractPhase('ascending')).toBe('ascending');
  });
});
