// Copied from tests/ddr.test.ts. The report assertions of the last test (reportFiles/reportSections) move with report.
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessDdr, resolveDdrAssessments, type DdrAssessmentConfig, type ResolvedDdrAssessment } from '../../src/ddr'
import { foldProbeEye as fold, type EyeGate } from '../../src/observation'
import type { SimulationPlan } from '../../src/simulation'
import type { Geometry } from '../../src/board'
import { receivedDqsWindows } from '../../scripts/verification/audit-ddr.mjs'

// Old foldProbeEye(rows, {...eye, captureTimesSeconds}, points) in observation's signature.
const foldProbeEye = (rows: number[][], { captureTimesSeconds, ...eye }: EyeGate & { captureTimesSeconds: number[] }, pointsPerWindow: number) =>
  fold(rows, eye, { alignment: { kind: 'received-differential-dqs', captureTimesSeconds }, pointsPerWindow })

const ns = 1e-9
// Synthetic requirements only. These numbers are deliberately not device defaults.
const config: DdrAssessmentConfig = {
  name: 'synthetic write', dataProbe: 'DQ', strobeProbe: 'DQS_DIFF', direction: 'write', sampleOffsetSeconds: 0,
  vrefV: .75, thresholds: { vilAcV: .55, vilDcV: .65, vihDcV: .85, vihAcV: .95 },
  setupSeconds: .2 * ns, holdSeconds: .2 * ns, minimumStrobeDifferentialV: .5, maximumStrobeIntervalErrorSeconds: .05 * ns,
}
const probe = (name: string, column: number, signal: string, reference: string, referenceNode = '0') => ({
  name, column, simulationVoltageProbeId: name, signalSourceId: signal, referenceSourceId: reference, signalNode: signal, referenceNode,
})
const resolved: ResolvedDdrAssessment = {
  config, data: probe('DQ', 1, 'dq', 'gnd'), strobe: probe('DQS_DIFF', 2, 'dqs', 'dqsn', 'dqsn'),
  eye: { name: 'DQ eye', simulationEyeDiagramId: 'eye', simulationExperimentId: 'run', simulationVoltageProbeId: 'DQ',
    column: 1, unitIntervalSeconds: ns, timeOriginSeconds: 0, startTimeSeconds: ns, endTimeSeconds: 9 * ns },
}
const approximately = (actual: number | undefined, expected: number) => assert.ok(Math.abs(actual! - expected) < 1e-20, `${actual} != ${expected}`)
function alternating(t: number, phase: number, low: number, high: number) {
  const n = Math.round(t - phase), d = t - phase - n, odd = Math.abs(n % 2) === 1
  if (Math.abs(d) <= .1 + 1e-12) return (odd ? high : low) + (odd ? low - high : high - low) * (d + .1) / .2
  return Math.abs(Math.floor(t - phase) % 2) === 1 ? low : high
}
function waveform({ dqDelay = 0, dqsDelay = 0, quiet = false, dq = (t: number) => alternating(t, dqDelay, 0, 1.5),
  strobe = (t: number) => quiet ? -1.5 : alternating(t, .5 + dqsDelay, -1.5, 1.5), extra = [] as number[] } = {}) {
  const times = new Set([0, 10, ...extra])
  // Irregular adaptive timestamps plus every corner of the synthetic piecewise-linear signals.
  for (let t = 0; t < 10; t += .137) times.add(t)
  for (let i = -1; i <= 11; i++) for (const delta of [-.1, 0, .1]) for (const phase of [dqDelay, .5 + dqsDelay]) {
    const t = i + phase + delta
    if (t > 0 && t < 10) times.add(t)
  }
  return [...times].sort((a, b) => a - b).map(t => [t * ns, dq(t), strobe(t)])
}

test('received differential DQS delay controls both the DQ eye and interpolated setup/hold', () => {
  const rows = waveform(), baseline = assessDdr(rows, resolved)
  assert.equal(baseline.status, 'illustrative')
  assert.equal(baseline.checks.status, 'within-configured-limits')
  assert.equal(baseline.compliance.status, 'not-evaluated')
  assert.equal(baseline.captures.length, 8)
  approximately(baseline.captures[0].setupSeconds, (0.5 - (-.1 + .95 / 1.5 * .2)) * ns)
  approximately(baseline.captures[0].holdSeconds, (0.5 - .1 + .65 / 1.5 * .2) * ns)
  const delay = .3, delayedRows = waveform({ dqDelay: delay, dqsDelay: delay }), delayed = assessDdr(delayedRows, resolved)
  assert.equal(delayed.checks.status, 'within-configured-limits')
  for (const [i, capture] of delayed.captures.entries()) {
    approximately(capture.sampleTimeSeconds - baseline.captures[i].sampleTimeSeconds, delay * ns)
    approximately(capture.setupSeconds, baseline.captures[i].setupSeconds!)
    approximately(capture.holdSeconds, baseline.captures[i].holdSeconds!)
  }
  const fold = (rows: number[][], captureTimesSeconds: number[]) => foldProbeEye(rows, { ...resolved.eye, captureTimesSeconds }, 5)
  const a = fold(rows, baseline.captureTimesSeconds), b = fold(delayedRows, delayed.captureTimesSeconds)
  assert.equal(a.metrics.alignment, 'received-differential-dqs')
  assert.equal(a.metrics.timeOriginSeconds, null)
  for (let i = 0; i < a.windows; i++) approximately(b.windowOriginsSeconds[i] - a.windowOriginsSeconds[i], delay * ns)
  for (const [window, offset, time] of b.samples) if (offset === ns) approximately(time, delayed.captureTimesSeconds[window + 1])
  assert.equal(assessDdr(waveform({ dqsDelay: .4 }), resolved).status, 'violated', 'relative strobe delay consumes real hold margin')
})

test('quiet or insufficient differential strobe never passes and produces no received eye windows', () => {
  const rows = waveform({ quiet: true }), result = assessDdr(rows, resolved)
  assert.equal(result.status, 'not-evaluated')
  assert.equal(result.checks.status, 'not-evaluated')
  assert.equal(result.compliance.status, 'not-evaluated')
  assert.deepEqual(result.captureTimesSeconds, [])
  assert.match(result.reasons.join(' '), /quiet/)
  assert.equal(foldProbeEye(rows, { ...resolved.eye, captureTimesSeconds: result.captureTimesSeconds }, 5).windows, 0)
  const small = assessDdr(waveform({ strobe: t => alternating(t, .5, -.05, .05) }), resolved)
  assert.equal(small.status, 'not-evaluated'); assert.match(small.reasons.join(), /differential magnitude/)
  const sparse = foldProbeEye([[0, 0], [10 * ns, 10]], { ...resolved.eye, captureTimesSeconds: [] }, 5)
  sparse.metrics.voltageRangeV.forEach((v: number, i: number) => assert.ok(Math.abs(v - [1, 9][i]) < 1e-12,
    'range includes interpolated gate boundaries even with no interior solver samples'))
})

test('DQS recrossings, missing edges and exact-zero plateaus invalidate the timing reference', () => {
  const rows = waveform({ extra: [2.62, 2.66, 2.7] })
  rows.find(r => Math.abs(r[0] / ns - 2.66) < 1e-12)![2] = -1
  const ringing = assessDdr(rows, resolved)
  assert.equal(ringing.status, 'not-evaluated')
  assert.equal(ringing.strobe.status, 'violated')
  assert.match(ringing.reasons.join(), /extra or missing/)
  assert.deepEqual(ringing.captureTimesSeconds, [], 'do not silently remove ringing and recover a favorable phase')
  const missing = waveform().map(r => r[0] > 4 * ns && r[0] < 7 * ns ? [r[0], r[1], 1.5] : r)
  assert.equal(assessDdr(missing, resolved).strobe.status, 'violated')
  const plateau = waveform({ extra: [2.49, 2.51] }).map(r => r[0] >= 2.49 * ns && r[0] <= 2.51 * ns ? [r[0], r[1], 0] : r)
  assert.equal(assessDdr(plateau, resolved).strobe.status, 'violated')
  const touch = waveform({ extra: [2.65] }).map(r => Math.abs(r[0] / ns - 2.65) < 1e-12 ? [r[0], r[1], 0] : r)
  assert.equal(assessDdr(touch, resolved).strobe.status, 'violated', 'an exact-zero tangency is ambiguous even without a sign reversal')
})

test('AC acquisition, DC capture and both setup/hold limits are independent checks', () => {
  const ac = assessDdr(waveform({ dq: t => alternating(t, 0, .6, .9) }), resolved)
  assert.equal(ac.status, 'violated'); assert.match(ac.captures[0].reason!, /AC threshold/)
  const dc = assessDdr(waveform({ dq: t => alternating(t, 0, .7, .8) }), resolved)
  assert.equal(dc.status, 'violated'); assert.equal(dc.captures[0].level, 'indeterminate')
  assert.match(dc.captures[0].reason!, /DC-invalid/)
  const setup = assessDdr(waveform(), { ...resolved, config: { ...config, setupSeconds: .48 * ns } })
  assert.equal(setup.status, 'violated'); assert.ok(setup.captures[0].setupMarginSeconds! < 0)
  const hold = assessDdr(waveform(), { ...resolved, config: { ...config, holdSeconds: .49 * ns } })
  assert.equal(hold.status, 'violated'); assert.ok(hold.captures[0].holdMarginSeconds! < 0)
})

test('DQ ringing through DC resets AC setup, while a dip only through AC does not', () => {
  const ring = (minimum: number) => {
    const rows = waveform({ extra: [2.3, 2.35, 2.4] })
    rows.find(r => Math.abs(r[0] / ns - 2.35) < 1e-12)![1] = minimum
    return assessDdr(rows, resolved)
  }
  const dcRing = ring(.8), high = dcRing.captures.find(c => Math.abs(c.sampleTimeSeconds / ns - 2.5) < 1e-9)!
  assert.equal(high.status, 'violated'); assert.ok(high.setupSeconds! < .2 * ns)
  assert.equal(ring(.9).checks.status, 'within-configured-limits')
})

test('incomplete gate, truncated aperture and absent data cannot satisfy an assessment', () => {
  const partial = assessDdr(waveform().filter(r => r[0] < 8 * ns), resolved)
  assert.equal(partial.status, 'not-evaluated'); assert.match(partial.reasons.join(), /Incomplete capture/)
  const aperture = assessDdr(waveform(), { ...resolved, eye: { ...resolved.eye, startTimeSeconds: 1.45 * ns } })
  assert.equal(aperture.status, 'not-evaluated'); assert.equal(aperture.checks.unevaluated, 1)
  assert.equal(aperture.captures[0].voltageV, null)
  assert.equal(assessDdr([[0, NaN, 0], [10 * ns, 1, 1]], resolved).status, 'not-evaluated')
  const constant = assessDdr(waveform({ dq: () => 1.5 }), resolved)
  assert.equal(constant.checks.status, 'within-configured-limits')
  assert.equal(constant.captures[0].setupIsLowerBound, true)
  assert.equal(constant.captures[0].holdIsLowerBound, true)
})

test('characterized limits require complete evidence and still never establish protocol compliance', () => {
  const characterized = { ...config, characterization: { source: 'Synthetic fixture, no device claim', receiver: 'test receiver', speedGrade: 'test',
    conditions: 'ideal test corner', derating: 'test only', referencePlane: 'receiver-pad' as const } }
  const result = assessDdr(waveform(), { ...resolved, config: characterized })
  assert.equal(result.status, 'within-characterized-limits')
  assert.equal(result.compliance.status, 'not-evaluated')
  assert.match(result.limitations.join(), /not been independently verified/)
  assert.throws(() => assessDdr(waveform(), { ...resolved, config: { ...characterized, characterization: { ...characterized.characterization, derating: '' } } }), /characterization requires/)
  assert.throws(() => assessDdr(waveform(), { ...resolved, config: { ...config, setupSeconds: undefined as never } }), /explicit finite setupSeconds/)
  assert.throws(() => assessDdr(waveform(), { ...resolved, config: { ...config, thresholds: { ...config.thresholds, vihAcV: .8 } } }), /VIL\(AC\)/)
})

test('assessment config binds native receiver probes and existing eyes across quiet/switching experiments', () => {
  const plan = { name: 'switching', simulationExperimentId: 'run', probes: [resolved.data, resolved.strobe], eyes: [resolved.eye],
    states: ['dq', 'dqs', 'dqsn'].map(source_port_id => ({ source_port_id, is_output: false })) } as SimulationPlan
  const geometry = { mappings: ['dq', 'dqs', 'dqsn'].map(to => ({ to })) } as Geometry
  assert.equal(resolveDdrAssessments([plan], geometry, [config]).length, 1)
  assert.throws(() => resolveDdrAssessments([plan], geometry, [{ ...config, strobeProbe: 'TX' }]), /exactly one native/)
  assert.throws(() => resolveDdrAssessments([{ ...plan, probes: [resolved.data, { ...resolved.strobe, signalSourceId: 'tx' }] }], geometry, [config]), /receiver pads/)
  assert.throws(() => resolveDdrAssessments([plan], geometry, [{ ...config, maximumStrobeIntervalErrorSeconds: ns }]), /half a UI/)
  assert.throws(() => resolveDdrAssessments([plan], geometry, [{ ...config, experimentNames: ['typo'] }]), /unknown experiment/)
  assert.throws(() => resolveDdrAssessments([plan], geometry, [config, { ...config, name: 'duplicate eye' }]), /same data eye/)
  assert.deepEqual(resolveDdrAssessments([plan], geometry), [])
})

test('received eye audit derives crossings independently for illustrative and quiet status', () => {
  for (const quiet of [false, true]) {
    const rows = waveform({ quiet }), ddrAssessment = assessDdr(rows, resolved)
    const folded = foldProbeEye(rows, { ...resolved.eye, captureTimesSeconds: ddrAssessment.captureTimesSeconds }, 5)
    const eye = { ...resolved.eye, ...folded, alignment: 'received-differential-dqs', ddrAssessment }
    const windows = receivedDqsWindows(rows, [resolved.data, resolved.strobe], eye, [config])
    assert.deepEqual(windows.map(w => w.start), folded.windowOriginsSeconds)
    if (!quiet) {
      const corrupted = structuredClone(eye)
      corrupted.ddrAssessment.captureTimesSeconds[0] += .1 * ns
      assert.throws(() => receivedDqsWindows(rows, [resolved.data, resolved.strobe], corrupted, [config]), /Received sampling time/)
      const capture = ddrAssessment.captures.find(c => c.status === 'within-configured-limits')!
      const index = rows.findIndex(row => row[0] > capture.sampleTimeSeconds && row[0] < capture.sampleTimeSeconds + config.holdSeconds)
      assert.ok(index >= 0)
      const invalid = structuredClone(rows)
      invalid[index][resolved.data.column] = config.vrefV
      assert.throws(() => receivedDqsWindows(invalid, [resolved.data, resolved.strobe], eye, [config]), /DC-valid/)
    }
  }
})
