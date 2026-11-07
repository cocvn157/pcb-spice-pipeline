// Golden: the ported observation functions agree with the pre-module src/metrics.mjs (and the
// general-pipeline.ts eye loop) value-for-value and error-for-error on seeded synthetic waveforms.
// Oracle: committed digests (tests/observation/golden.snapshot.json) recorded from the pre-module
// flat src/ while it still existed (see tests/support/golden.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { foldProbeEye, probeWaveformRows, foldEyes, type EyeAlignment, type EyeFoldInput, type EyeRequest } from '../../src/observation/index.js'
import { rootScope } from '../../src/kernel/index.js'
import { goldenDigests } from '../support/golden.js'

const golden = goldenDigests(new URL('./golden.snapshot.json', import.meta.url))

type Outcome = { ok: true; value: unknown } | { ok: false; code: unknown; message: string; name: string }
function outcome(f: () => unknown): Outcome {
  try { return { ok: true, value: f() } } catch (e) {
    const err = e as { code?: unknown; message: string; constructor: { name: string } }
    return { ok: false, code: err.code, message: err.message, name: err.code === undefined ? err.constructor.name : 'Diagnostic' }
  }
}

function waveform(r: Rng, columns: number): number[][] {
  const n = r.int(2, 60), rows: number[][] = []
  let t = r.pick([0, 0, r.float(-1e-9, 2e-9)])
  for (let i = 0; i < n; i++) {
    rows.push([t, ...Array.from({ length: columns }, () => r.pick([0, 1.5, r.float(-2, 2)]))])
    t += r.pick([r.float(1e-12, 5e-10), 1e-10, r.float(1e-13, 2e-9)])
  }
  return rows
}
function eyeFor(r: Rng, rows: number[][], columns: number): EyeRequest {
  const t0 = rows[0][0], t1 = rows.at(-1)![0], span = t1 - t0
  const ui = r.pick([span / r.int(1, 12), 1e-9, 2.5e-10, span * r.float(0.01, 0.6), r.pick([0, -1e-9, NaN])])
  return {
    simulationEyeDiagramId: `eye${r.int(0, 3)}`, name: 'DQ' + r.int(0, 9), simulationExperimentId: 'run', simulationVoltageProbeId: 'DQ',
    column: r.pick([1, 1, columns, r.int(1, columns), 0, columns + 1]),
    unitIntervalSeconds: ui, timeOriginSeconds: r.pick([0, t0, r.float(t0 - span, t1), r.pick([NaN, t0 + ui / 4])]),
    startTimeSeconds: r.pick([t0, r.float(t0 - span / 4, t1)]), endTimeSeconds: r.pick([t1, r.float(t0, t1 + span / 4), Infinity]),
  } as EyeRequest
}
function captures(r: Rng, rows: number[][]): number[] {
  const t0 = rows[0][0], t1 = rows.at(-1)![0], n = r.int(0, 20)
  const xs = Array.from({ length: n }, () => r.float(t0 - (t1 - t0) / 5, t1 + (t1 - t0) / 5)).sort((a, b) => a - b)
  if (r.next() < 0.1 && xs.length > 1) xs[1] = xs[0] // non-increasing
  if (r.next() < 0.05 && xs.length) xs[0] = NaN
  return xs
}

test('foldProbeEye matches the pre-module metrics.mjs for stimulus-clock and received captures (seeded)', () => golden('fold', see => {
  let folded = 0, failed = 0, received = 0
  for (let seed = 1; seed <= 3000; seed++) {
    const r = rng(seed), columns = r.int(1, 3), rows = waveform(r, columns), eye = eyeFor(r, rows, columns)
    const points = r.pick([2, 3, 5, 17, 1200, 1, 2.5]), limits = r.pick([undefined, {}, { maxWindows: r.int(1, 30) }, { maxSamples: r.int(1, 400) }])
    const capture = r.next() < 0.4 ? captures(r, rows) : undefined
    const alignment: EyeAlignment = capture ? { kind: 'received-differential-dqs', captureTimesSeconds: capture } : { kind: 'stimulus-clock' }
    const now = outcome(() => foldProbeEye(rows, eye, { alignment, pointsPerWindow: points, limits }))
    see(`seed ${seed}`, now)
    if (now.ok) { folded++; if (capture && (now.value as { windows: number }).windows) received++ } else failed++
  }
  assert.ok(folded > 500 && failed > 300 && received > 100, `coverage: ${folded} folded (${received} received with windows), ${failed} failed`)
}))

test('eye_interpolation fires when the epsilon-admitted last window overruns the recording', () => golden('interpolation', see => {
  const rows = [[0, 0], [3.5 - 5e-10, 1]], eye = { name: 'x', column: 1, unitIntervalSeconds: 1, timeOriginSeconds: 0, startTimeSeconds: 0, endTimeSeconds: 10 }
  see('fold', outcome(() => foldProbeEye(rows, eye, { pointsPerWindow: 5 })))
  assert.throws(() => foldProbeEye(rows, eye, { pointsPerWindow: 5 }), { code: 'eye_interpolation', message: 'eye_interpolation: Eye sample is outside the recorded waveform' })
}))

test('probeWaveformRows matches the pre-module metrics.mjs on seeded ngspice text', () => golden('waveform', see => {
  let parsed = 0
  for (let seed = 1; seed <= 1000; seed++) {
    const r = rng(seed), probes = Array.from({ length: r.int(1, 4) }, () => ({})), n = r.int(0, 8)
    let t = r.float(-1, 1)
    const lines = [' time ' + probes.map((_, i) => `v${i}`).join('  ')]
    for (let i = 0; i < n; i++) {
      const cells = [t, ...probes.map(() => r.float(-3, 3))].map(v => r.pick([String(v), v.toExponential(), v.toFixed(3)]))
      if (r.next() < 0.05) cells.push('0')
      if (r.next() < 0.05) cells[r.int(0, cells.length - 1)] = r.pick(['NaN', 'inf', 'x'])
      lines.push(r.pick(['', '  ', '\t']) + cells.join(r.pick([' ', '  ', '\t'])))
      t += r.next() < 0.03 ? r.pick([0, -1e-12]) : r.pick([r.float(1e-12, 1e-9), 1e-10])
    }
    const text = lines.join(r.pick(['\n', '\r\n'])) + r.pick(['', '\n', '\r\n  '])
    const now = outcome(() => probeWaveformRows(text, probes))
    see(`seed ${seed}`, now)
    if (now.ok) parsed++
  }
  assert.ok(parsed > 200 && parsed < 900, `parsed ${parsed}`)
}))

test('foldEyes writes the same eye-data.csv, eye-data.json and eyes.json bytes as the pre-module pipeline loop', () => golden('foldEyes', see => {
  let compared = 0
  for (let seed = 1; seed <= 120; seed++) {
    const r = rng(seed), rows = waveform(r, 2), t0 = rows[0][0], t1 = rows.at(-1)![0], ui = (t1 - t0) / r.int(3, 10)
    const eyes = Array.from({ length: r.int(1, 3) }, (_, i) => {
      const eye = { simulationEyeDiagramId: `eye_${i}`, name: `E${i}`, simulationExperimentId: 'run-1', simulationVoltageProbeId: 'DQ', column: r.int(1, 2),
        unitIntervalSeconds: ui, timeOriginSeconds: t0 + r.float(0, ui), startTimeSeconds: t0, endTimeSeconds: t1 } as EyeRequest
      return r.next() < 0.5 ? { eye } : { eye, ddrAssessment: { status: 'illustrative', captureTimesSeconds: captures(r, rows).filter(Number.isFinite).filter((t, j, a) => !j || t > a[j - 1]) } }
    })
    const sha = 'ab'.repeat(32)
    const inputs: EyeFoldInput[] = eyes.map(({ eye, ddrAssessment }) => ddrAssessment
      ? { request: eye, alignment: { kind: 'received-differential-dqs', captureTimesSeconds: ddrAssessment.captureTimesSeconds }, ddrAssessment }
      : { request: eye, alignment: { kind: 'stimulus-clock' } })
    const now = outcome(() => foldEyes(rows, inputs, { sha256: sha }, rootScope('observation').child('experiments', 'run-1')))
    if (!now.ok) { see(`seed ${seed}`, now); continue }
    const produced = now.value as ReturnType<typeof foldEyes>
    const files = Object.fromEntries(produced.artifacts.map(a => [a.path, a.body]))
    see(`seed ${seed} files`, files)
    see(`seed ${seed} value`, produced.value)
    assert.ok(produced.artifacts.every(a => a.owner === 'observation'))
    compared++
  }
  assert.ok(compared > 60, `compared ${compared}`)
}))

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
