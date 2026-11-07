// foldProbeEye (src/observation/fold.ts). Gathers the oracle test with the fold tests copied from
// tests/eyediagram.test.mjs, tests/general.test.mjs, tests/metrics.test.mjs and tests/ddr.test.ts.
//
// Oracle (docs/ARCHITECTURE.md, Verification): brute-force enumerate every candidate window and assert the
// closed-form fold keeps exactly the complete ones. All times sit on a dyadic grid (exact in binary64),
// so "complete" is decided by exact comparison, independent of the fold's epsilon tolerance.
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Diagnostic } from '../../src/kernel'
import { foldProbeEye, type EyeGate, type EyeLimits, type FoldedEye, type WaveformRows } from '../../src/observation'

/** A random time on the 1/16 s dyadic grid in [lo, hi], so window-completeness comparisons are exact. */
const grid = (r: Rng, lo: number, hi: number): number => r.int(lo * 16, hi * 16) / 16
/** A random recording with strictly increasing grid timestamps and one random voltage column. */
function recording(r: Rng): number[][] {
  const t0 = grid(r, -4, 4)
  const times = [t0]
  for (let i = r.int(1, 40); i > 0; i--) times.push(times.at(-1)! + r.int(1, 24) / 16)
  return times.map(t => [t, r.float(-1, 1)])
}
/** A random eye gate (UI, origin, start, end on the grid) around the given recording. */
function gate(r: Rng, rows: number[][]): EyeGate {
  const t0 = rows[0][0]
  const t1 = rows.at(-1)![0]
  return {
    name: 'oracle', column: 1, unitIntervalSeconds: r.pick([0.25, 0.5, 1, 2]), timeOriginSeconds: grid(r, t0 - 3, t1),
    startTimeSeconds: r.pick([t0, grid(r, t0 - 2, t1)]), endTimeSeconds: r.pick([t1, grid(r, t0, t1 + 2)]),
  }
}

test('stimulus-clock fold keeps exactly the brute-force complete windows b_k-UI/2..b_k+3UI/2', () => {
  let nonEmpty = 0
  let empty = 0
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed)
    const rows = recording(r)
    const eye = gate(r, rows)
    const ui = eye.unitIntervalSeconds
    const start = Math.max(rows[0][0], eye.startTimeSeconds)
    const end = Math.min(rows.at(-1)![0], eye.endTimeSeconds)
    const expected: number[] = []
    const span = Math.ceil((Math.abs(rows[0][0]) + Math.abs(rows.at(-1)![0]) + Math.abs(eye.timeOriginSeconds)) / ui) + 4
    for (let k = -span; k <= span; k++) {
      const b = eye.timeOriginSeconds + k * ui
      if (b - ui / 2 >= start && b + 3 * ui / 2 <= end) expected.push(k)
    }
    const points = r.int(2, 9)
    if (!expected.length) {
      assert.throws(() => foldProbeEye(rows, eye, { pointsPerWindow: points }), { code: 'eye_windows' }, `seed ${seed}`)
      empty++
      continue
    }
    const folded = foldProbeEye(rows, eye, { pointsPerWindow: points })
    assert.deepEqual(folded.boundaryIndices, expected, `seed ${seed}`)
    assert.deepEqual(folded.windowOriginsSeconds, expected.map(k => eye.timeOriginSeconds + k * ui - ui / 2), `seed ${seed}`)
    assert.equal(folded.windows, expected.length)
    assert.equal(folded.samples.length, expected.length * points)
    for (const [w, offset, time] of folded.samples) {
      assert.ok(time >= start && time <= end, `seed ${seed}: sample outside gate`)
      assert.equal(time, folded.windowOriginsSeconds[w] + offset)
    }
    nonEmpty++
  }
  assert.ok(nonEmpty > 500 && empty > 100, `coverage ${nonEmpty}/${empty}`)
})

test('received-capture fold keeps exactly the captures whose [c-UI, c+UI] lies inside gate and recording', () => {
  let kept = 0
  let dropped = 0
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed)
    const rows = recording(r)
    const eye = gate(r, rows)
    const ui = eye.unitIntervalSeconds
    const start = Math.max(rows[0][0], eye.startTimeSeconds)
    const end = Math.min(rows.at(-1)![0], eye.endTimeSeconds)
    const captureTimesSeconds = [...new Set(Array.from({ length: r.int(0, 15) }, () => grid(r, rows[0][0] - 2, rows.at(-1)![0] + 2)))].sort((a, b) => a - b)
    const expected = captureTimesSeconds.filter(c => c - ui >= start && c + ui <= end)
    const folded = foldProbeEye(rows, eye, { alignment: { kind: 'received-differential-dqs', captureTimesSeconds }, pointsPerWindow: 3 })
    assert.deepEqual(folded.windowOriginsSeconds, expected.map(c => c - ui), `seed ${seed}`)
    assert.deepEqual(folded.boundaryIndices, [])
    for (const [w, offset, time] of folded.samples) if (offset === ui) assert.equal(time, expected[w])
    kept += expected.length
    dropped += captureTimesSeconds.length - expected.length
  }
  assert.ok(kept > 1000 && dropped > 1000, `coverage ${kept}/${dropped}`)
})

// Old positional foldProbeEye(rows, eye, pointsPerWindow, limits) from tests/eyediagram.test.mjs and tests/general.test.mjs.
/** Fold with the default stimulus-clock alignment at a given resolution, in the pre-module positional call shape. */
function foldPoints(rows: WaveformRows, eye: EyeGate, pointsPerWindow: number, limits?: EyeLimits): FoldedEye {
  return foldProbeEye(rows, eye, { pointsPerWindow, limits })
}

// Copied from tests/eyediagram.test.mjs (foldProbeEye tests only; eyeSimulation/resolveEyeDiagram/
// measureWaveform/foldEye are legacy two-lane clock-eye code and were not ported).
test('empty eye gate reports timing and skipped UIs instead of an empty eye', () => {
  const eye = { name: 'DQ0', column: 1, unitIntervalSeconds: 2.5e-9, timeOriginSeconds: 0,
    startTimeSeconds: 40e-9, endTimeSeconds: 45e-9 }
  const rows = [[0, 0], [40e-9, 1], [45e-9, 0]]
  assert.throws(() => foldPoints(rows, eye, 5), (thrown: unknown) => {
    const error = thrown as Diagnostic
    assert.equal(error.code, 'eye_windows')
    assert.match(error.message, /DQ0: no complete two-UI windows/)
    assert.ok(error.message.includes(`gate [${eye.startTimeSeconds}, ${eye.endTimeSeconds}] s`))
    assert.ok(error.message.includes(`UI ${eye.unitIntervalSeconds} s`))
    assert.match(error.message, /skip 16 UI/)
    return true
  })
})

test('two-UI eye windows center half a UI after stimulus bit boundaries', () => {
  const ui = 2.5e-9
  const origin = 1.25e-9
  const eye = { name: 'DQ0', column: 1, unitIntervalSeconds: ui, timeOriginSeconds: origin,
    startTimeSeconds: origin + 16 * ui, endTimeSeconds: origin + 20 * ui }
  // A ramp makes interpolated voltage equal absolute time, independent of bit levels.
  const folded = foldPoints([[0, 0], [100e-9, 100e-9]], eye, 5)
  assert.deepEqual(folded.boundaryIndices, [17, 18])
  assert.equal(folded.windows, 2)
  for (const [window, offset, time, value] of folded.samples) {
    const boundary = origin + folded.boundaryIndices[window] * ui
    assert.ok(Math.abs(time - (boundary - ui / 2 + offset)) < 1e-22)
    assert.ok(Math.abs(value - time) < 1e-22)
    if (offset === ui) assert.ok(Math.abs(time - (boundary + ui / 2)) < 1e-22)
  }
})

test('aligned nanosecond gates tolerate floating-point roundoff at either boundary', () => {
  for (const scale of [1e-3, 1, 1e3]) {
    // Match the native ns -> Circuit JSON ms -> seconds conversion.
    const ui = 2.5 * 1e-6 / 1000 * scale
    const start = 41.25e-9 * scale
    const end = 46.250001e-9 * scale
    const eye = { name: 'DQ0', column: 1, unitIntervalSeconds: ui, timeOriginSeconds: 0,
      startTimeSeconds: start, endTimeSeconds: end }
    const folded = foldPoints([[0, 0], [100e-9 * scale, 100e-9 * scale]], eye, 5)
    assert.deepEqual(folded.boundaryIndices, [17])
    assert.equal(folded.windows, 1)
    for (const [, , time, value] of folded.samples) assert.ok(Math.abs(value - time) < ui * 1e-12)
    // Rounding at the end of a recorded waveform must also preserve the window.
    assert.equal(foldPoints([[start, 0], [start + 2 * ui, 1]], { ...eye, endTimeSeconds: start + 2 * ui }, 5).windows, 1)
    assert.throws(() => foldPoints([[0, 0], [100e-9 * scale, 0]], { ...eye, startTimeSeconds: start + ui * 1e-6 }, 5), /eye_windows/)
    assert.throws(() => foldPoints([[0, 0], [100e-9 * scale, 0]], { ...eye, endTimeSeconds: start + 2 * ui - ui * 1e-6 }, 5), /eye_windows/)
  }
})

// Copied from tests/general.test.mjs (the foldProbeEye test).
test('fixed eye origin/gates fold irregular timestamps and repeated levels without clock parity', () => {
  const rows = [[0, 0], [.2, 0], [.7, 1], [1.4, 1], [1.8, 1], [2.2, -.3], [2.8, 0], [3.6, 0], [4.4, 1], [5, 1]]
  const eye = { name: 'data', column: 1, unitIntervalSeconds: 1, timeOriginSeconds: .25, startTimeSeconds: 0, endTimeSeconds: 5 }
  const result = foldPoints(rows, eye, 5)
  assert.deepEqual(result.windowOriginsSeconds, [.75, 1.75, 2.75])
  assert.deepEqual(result.boundaryIndices, [1, 2, 3])
  assert.equal(result.samples.length, 15)
  assert.deepEqual(result.windowOriginsSeconds, foldPoints(rows.map(([time, v]) => [time, -v]), eye, 5).windowOriginsSeconds)
  assert.deepEqual(foldPoints(rows.map(([time]) => [time, 3.3]), eye, 5).metrics.voltageRangeV, [3.3, 3.3], 'constant drive is a valid observed voltage waveform')
  const sample = result.samples[0]
  const fraction = (sample[2] - .7) / (1.4 - .7)
  assert.equal(sample[3], rows[2][1] + (rows[3][1] - rows[2][1]) * fraction)
  assert.throws(() => foldPoints(rows, { ...eye, startTimeSeconds: 4.5 }, 5), /no complete/)
})

// Copied from tests/metrics.test.mjs (foldProbeEye half of the budget test; measureWaveform/foldEye are legacy, not ported).
test('eye budgets reject window and sample amplification before interpolation', () => {
  const rows = [[0, 0], [5, 1]]
  const eye = { name: 'bounded', column: 1, unitIntervalSeconds: 1, timeOriginSeconds: .5, startTimeSeconds: 0, endTimeSeconds: 5 }
  for (const fold of [
    (points: number, limits?: EyeLimits, ui = 1) => foldProbeEye(rows, { ...eye, unitIntervalSeconds: ui }, { pointsPerWindow: points, limits }),
  ]) {
    assert.throws(() => fold(2, { maxWindows: 3 }), /eye_budget.*windows/)
    assert.throws(() => fold(3, { maxSamples: 11 }), /eye_budget.*samples/)
    assert.throws(() => fold(1e9), /eye_budget.*samples/)
    assert.throws(() => fold(2, undefined, 1e-8), /eye_budget.*windows/)
    assert.throws(() => fold(2, undefined, 1e-20), /eye_budget/)
    assert.throws(() => fold(2, { maxSamples: Infinity }), /eye_budget/)
    const result = fold(3, { maxWindows: 4, maxSamples: 12 })
    assert.equal(result.windows, 4)
    assert.equal(result.samples.length, 12)
  }
})

// Copied from tests/ddr.test.ts: the received-alignment fold assertion that does not need assessDdr
// (the others fold assessDdr output; the ddr module's tests own those, index.test.ts covers the path here).
test('quiet or insufficient differential strobe never passes and produces no received eye windows', () => {
  const ns = 1e-9
  const resolved: { eye: EyeGate } = {
    eye: { name: 'DQ eye', column: 1, unitIntervalSeconds: ns, timeOriginSeconds: 0, startTimeSeconds: ns, endTimeSeconds: 9 * ns },
  }
  const sparse = foldProbeEye([[0, 0], [10 * ns, 10]], resolved.eye, { alignment: { kind: 'received-differential-dqs', captureTimesSeconds: [] }, pointsPerWindow: 5 })
  sparse.metrics.voltageRangeV.forEach((v: number, i: number) => assert.ok(Math.abs(v - [1, 9][i]) < 1e-12,
    'range includes interpolated gate boundaries even with no interior solver samples'))
  assert.equal(sparse.windows, 0)
  assert.equal(sparse.metrics.alignment, 'received-differential-dqs')
  assert.equal(sparse.metrics.timeOriginSeconds, null)
})

/** Seeded PRNG (mulberry32) for property-style loops; no fast-check dependency. */
function rng(seed: number): Rng {
  let a = seed >>> 0
  /** Advance the mulberry32 state and return a uniform float in [0, 1). */
  const next = (): number => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    float: (lo: number, hi: number) => lo + (hi - lo) * next(),
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
  }
}
interface Rng { next: () => number; float: (lo: number, hi: number) => number; int: (lo: number, hi: number) => number; pick: <T>(xs: readonly T[]) => T }
