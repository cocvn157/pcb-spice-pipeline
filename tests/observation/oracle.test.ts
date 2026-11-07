// Oracle (docs/ARCHITECTURE.md, Verification): brute-force enumerate every candidate window and assert the
// closed-form fold keeps exactly the complete ones. All times sit on a dyadic grid (exact in binary64),
// so "complete" is decided by exact comparison, independent of the fold's epsilon tolerance.
import test from 'node:test'
import assert from 'node:assert/strict'
import { foldProbeEye, type EyeGate } from '../../src/observation/index.js'

const grid = (r: Rng, lo: number, hi: number) => r.int(lo * 16, hi * 16) / 16
function recording(r: Rng): number[][] {
  const t0 = grid(r, -4, 4), times = [t0]
  for (let i = r.int(1, 40); i > 0; i--) times.push(times.at(-1)! + r.int(1, 24) / 16)
  return times.map(t => [t, r.float(-1, 1)])
}
function gate(r: Rng, rows: number[][]): EyeGate {
  const t0 = rows[0][0], t1 = rows.at(-1)![0]
  return {
    name: 'oracle', column: 1, unitIntervalSeconds: r.pick([0.25, 0.5, 1, 2]), timeOriginSeconds: grid(r, t0 - 3, t1),
    startTimeSeconds: r.pick([t0, grid(r, t0 - 2, t1)]), endTimeSeconds: r.pick([t1, grid(r, t0, t1 + 2)]),
  }
}

test('stimulus-clock fold keeps exactly the brute-force complete windows b_k-UI/2..b_k+3UI/2', () => {
  let nonEmpty = 0, empty = 0
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed), rows = recording(r), eye = gate(r, rows), ui = eye.unitIntervalSeconds
    const start = Math.max(rows[0][0], eye.startTimeSeconds), end = Math.min(rows.at(-1)![0], eye.endTimeSeconds)
    const expected: number[] = []
    const span = Math.ceil((Math.abs(rows[0][0]) + Math.abs(rows.at(-1)![0]) + Math.abs(eye.timeOriginSeconds)) / ui) + 4
    for (let k = -span; k <= span; k++) {
      const b = eye.timeOriginSeconds + k * ui
      if (b - ui / 2 >= start && b + 3 * ui / 2 <= end) expected.push(k)
    }
    const points = r.int(2, 9)
    if (!expected.length) {
      assert.throws(() => foldProbeEye(rows, eye, { pointsPerWindow: points }), { code: 'eye_windows' }, `seed ${seed}`)
      empty++; continue
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
  let kept = 0, dropped = 0
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed), rows = recording(r), eye = gate(r, rows), ui = eye.unitIntervalSeconds
    const start = Math.max(rows[0][0], eye.startTimeSeconds), end = Math.min(rows.at(-1)![0], eye.endTimeSeconds)
    const captureTimesSeconds = [...new Set(Array.from({ length: r.int(0, 15) }, () => grid(r, rows[0][0] - 2, rows.at(-1)![0] + 2)))].sort((a, b) => a - b)
    const expected = captureTimesSeconds.filter(c => c - ui >= start && c + ui <= end)
    const folded = foldProbeEye(rows, eye, { alignment: { kind: 'received-differential-dqs', captureTimesSeconds }, pointsPerWindow: 3 })
    assert.deepEqual(folded.windowOriginsSeconds, expected.map(c => c - ui), `seed ${seed}`)
    assert.deepEqual(folded.boundaryIndices, [])
    for (const [w, offset, time] of folded.samples) if (offset === ui) assert.equal(time, expected[w])
    kept += expected.length; dropped += captureTimesSeconds.length - expected.length
  }
  assert.ok(kept > 1000 && dropped > 1000, `coverage ${kept}/${dropped}`)
})

/** Seeded PRNG (mulberry32) for property-style loops; no fast-check dependency. */
function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
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
type Rng = ReturnType<typeof rng>
