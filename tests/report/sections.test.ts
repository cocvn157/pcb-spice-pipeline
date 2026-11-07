// Copied from tests/ddr.test.ts: the last test with its report assertions (reportFiles/reportSections).
// The DDR/audit-only part also lives in tests/ddr/assess.test.ts. Assertions unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessDdr, type DdrAssessmentConfig, type ResolvedDdrAssessment } from '../../src/ddr'
import { foldProbeEye as fold, type EyeGate, type FoldedEye } from '../../src/observation'
import { reportFiles, reportSections } from '../../src/report/sections'
import { receivedDqsWindows } from '../../scripts/verification/audit-ddr.mjs'

/** Old foldProbeEye(rows, {...eye, captureTimesSeconds}, points) in observation's signature. */
const foldProbeEye = (rows: number[][], { captureTimesSeconds, ...eye }: EyeGate & { captureTimesSeconds: number[] }, pointsPerWindow: number): FoldedEye =>
  fold(rows, eye, { alignment: { kind: 'received-differential-dqs', captureTimesSeconds }, pointsPerWindow })

const ns = 1e-9
// Synthetic requirements only. These numbers are deliberately not device defaults.
const config: DdrAssessmentConfig = {
  name: 'synthetic write', dataProbe: 'DQ', strobeProbe: 'DQS_DIFF', direction: 'write', sampleOffsetSeconds: 0,
  vrefV: .75, thresholds: { vilAcV: .55, vilDcV: .65, vihDcV: .85, vihAcV: .95 },
  setupSeconds: .2 * ns, holdSeconds: .2 * ns, minimumStrobeDifferentialV: .5, maximumStrobeIntervalErrorSeconds: .05 * ns,
}
/** A resolved voltage probe measuring `signal` against `reference`. */
const probe = (name: string, column: number, signal: string, reference: string, referenceNode: string = '0'): ResolvedDdrAssessment['data'] => ({
  name, column, simulationVoltageProbeId: name, signalSourceId: signal, referenceSourceId: reference, signalNode: signal, referenceNode,
})
const resolved: ResolvedDdrAssessment = {
  config, data: probe('DQ', 1, 'dq', 'gnd'), strobe: probe('DQS_DIFF', 2, 'dqs', 'dqsn', 'dqsn'),
  eye: { name: 'DQ eye', simulationEyeDiagramId: 'eye', simulationExperimentId: 'run', simulationVoltageProbeId: 'DQ',
    column: 1, unitIntervalSeconds: ns, timeOriginSeconds: 0, startTimeSeconds: ns, endTimeSeconds: 9 * ns },
}
/** Asserts two times agree to within 1e-20 s. */
const approximately = (actual: number | undefined, expected: number): void => assert.ok(Math.abs(actual! - expected) < 1e-20, `${actual} != ${expected}`)
/** A square wave toggling every unit interval after `phase`, with 0.2 UI linear edges. */
function alternating(t: number, phase: number, low: number, high: number): number {
  const n = Math.round(t - phase)
  const d = t - phase - n
  const odd = Math.abs(n % 2) === 1
  if (Math.abs(d) <= .1 + 1e-12) return (odd ? high : low) + (odd ? low - high : high - low) * (d + .1) / .2
  return Math.abs(Math.floor(t - phase) % 2) === 1 ? low : high
}
/** Synthetic DQ/DQS rows on irregular timestamps that include every edge corner (time in seconds). */
function waveform({ dqDelay = 0, dqsDelay = 0, quiet = false, dq = (t: number) => alternating(t, dqDelay, 0, 1.5),
  strobe = (t: number) => quiet ? -1.5 : alternating(t, .5 + dqsDelay, -1.5, 1.5), extra = [] as number[] }: { dqDelay?: number; dqsDelay?: number; quiet?: boolean; dq?: (t: number) => number; strobe?: (t: number) => number; extra?: number[] } = {}): number[][] {
  const times = new Set([0, 10, ...extra])
  // Irregular adaptive timestamps plus every corner of the synthetic piecewise-linear signals.
  for (let t = 0; t < 10; t += .137) times.add(t)
  for (let i = -1; i <= 11; i++) for (const delta of [-.1, 0, .1]) for (const phase of [dqDelay, .5 + dqsDelay]) {
    const t = i + phase + delta
    if (t > 0 && t < 10) times.add(t)
  }
  return [...times].sort((a, b) => a - b).map(t => [t * ns, dq(t), strobe(t)])
}

test('received eye audit derives crossings independently and reports expose illustrative and quiet status with limits', () => {
  for (const quiet of [false, true]) {
    const rows = waveform({ quiet })
    const ddrAssessment = assessDdr(rows, resolved)
    const folded = foldProbeEye(rows, { ...resolved.eye, captureTimesSeconds: ddrAssessment.captureTimesSeconds }, 5)
    const eye = { ...resolved.eye, ...folded, alignment: 'received-differential-dqs', ddrAssessment }
    const windows = receivedDqsWindows(rows, [resolved.data, resolved.strobe], eye, [config])
    assert.deepEqual(windows.map(w => w.start), folded.windowOriginsSeconds)
    const data = { runs: [{ name: quiet ? 'quiet' : 'switching', rows, probes: [resolved.data, resolved.strobe], eyes: [eye] }], limitations: [] }
    const files = reportFiles(data)
    const findings = reportSections(data, files).findings
    assert.match(findings, quiet ? /synthetic write · not-evaluated/ : /synthetic write · illustrative/)
    assert.match(findings, /DDR compliance: not-evaluated/)
    assert.match(findings, /VIL\(AC\) \/ VIL\(DC\)/)
    assert.match(findings, /Absent; illustrative limits only/)
    assert.match(findings, /Received DQS; capture at center/)
    assert.doesNotMatch(findings, /\bpass(?:ed)?\b/i)
    const summary = files.find(f => f.path === 'csv/ddr-summary.csv')!.content
    assert.match(summary, quiet ? /"not-evaluated"/ : /"illustrative"/)
    assert.ok(summary.includes('config_json'))
    const captureCsv = files.find(f => f.path.endsWith('-ddr-1.csv'))!.content
    assert.equal(captureCsv.trim().split('\n').length, ddrAssessment.captures.length + 1)
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
