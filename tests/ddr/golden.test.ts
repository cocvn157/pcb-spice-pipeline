// Golden: ddr is identical to the pre-module src/ddr.ts (results, codes, messages), including the
// strobe-gate -> 'not-evaluated' status rule. Oracle: committed digests (tests/ddr/golden.snapshot.json)
// recorded from the pre-module flat src/ while it still existed (see tests/support/golden.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessDdr, resolveDdrAssessments, validateDdrConfig, type DdrAssessmentConfig, type ResolvedDdrAssessment } from '../../src/ddr'
import type { SimulationPlan } from '../../src/simulation'
import type { Geometry } from '../../src/board'
import { goldenDigests } from '../support/golden'

const golden = goldenDigests(new URL('./golden.snapshot.json', import.meta.url))

const ns = 1e-9
const config: DdrAssessmentConfig = {
  name: 'synthetic write', dataProbe: 'DQ', strobeProbe: 'DQS_DIFF', direction: 'write', sampleOffsetSeconds: 0,
  vrefV: .75, thresholds: { vilAcV: .55, vilDcV: .65, vihDcV: .85, vihAcV: .95 },
  setupSeconds: .2 * ns, holdSeconds: .2 * ns, minimumStrobeDifferentialV: .5, maximumStrobeIntervalErrorSeconds: .05 * ns,
}
const characterization = { source: 's', receiver: 'r', speedGrade: 'g', conditions: 'c', derating: 'd', referencePlane: 'receiver-pad' as const }
const probe = (name: string, column: number, signal: string, reference: string, referenceNode = '0') => ({
  name, column, simulationVoltageProbeId: name, signalSourceId: signal, referenceSourceId: reference, signalNode: signal, referenceNode,
})
const resolved: ResolvedDdrAssessment = {
  config, data: probe('DQ', 1, 'dq', 'gnd'), strobe: probe('DQS_DIFF', 2, 'dqs', 'dqsn', 'dqsn'),
  eye: { name: 'DQ eye', simulationEyeDiagramId: 'eye', simulationExperimentId: 'run', simulationVoltageProbeId: 'DQ',
    column: 1, unitIntervalSeconds: ns, timeOriginSeconds: 0, startTimeSeconds: ns, endTimeSeconds: 9 * ns },
}
function alternating(t: number, phase: number, low: number, high: number) {
  const n = Math.round(t - phase), d = t - phase - n, odd = Math.abs(n % 2) === 1
  if (Math.abs(d) <= .1 + 1e-12) return (odd ? high : low) + (odd ? low - high : high - low) * (d + .1) / .2
  return Math.abs(Math.floor(t - phase) % 2) === 1 ? low : high
}
function waveform({ dqDelay = 0, dqsDelay = 0, quiet = false, dq = (t: number) => alternating(t, dqDelay, 0, 1.5),
  strobe = (t: number) => quiet ? -1.5 : alternating(t, .5 + dqsDelay, -1.5, 1.5), extra = [] as number[] } = {}) {
  const times = new Set([0, 10, ...extra])
  for (let t = 0; t < 10; t += .137) times.add(t)
  for (let i = -1; i <= 11; i++) for (const delta of [-.1, 0, .1]) for (const phase of [dqDelay, .5 + dqsDelay]) {
    const t = i + phase + delta
    if (t > 0 && t < 10) times.add(t)
  }
  return [...times].sort((a, b) => a - b).map(t => [t * ns, dq(t), strobe(t)])
}
const outcome = (fn: () => unknown) => { try { return { value: JSON.stringify(fn()) } } catch (e) { return { code: (e as { code?: string }).code, message: (e as Error).message } } }

test('golden: assessDdr equals the pre-module assessment on every waveform/config family', () => golden('assess', see => {
  const rows = [
    waveform(), waveform({ dqDelay: .3, dqsDelay: .3 }), waveform({ dqsDelay: .4 }), waveform({ quiet: true }),
    waveform({ strobe: t => alternating(t, .5, -.05, .05) }), waveform({ dq: t => alternating(t, 0, .6, .9) }), waveform({ dq: t => alternating(t, 0, .7, .8) }),
    waveform({ dq: () => 1.5 }), waveform().filter(r => r[0] < 8 * ns), waveform().map(r => r[0] > 4 * ns && r[0] < 7 * ns ? [r[0], r[1], 1.5] : r),
    waveform({ extra: [2.49, 2.51] }).map(r => r[0] >= 2.49 * ns && r[0] <= 2.51 * ns ? [r[0], r[1], 0] : r), [[0, NaN, 0], [10 * ns, 1, 1]], [[0, 0, 0]],
  ]
  const variants: ResolvedDdrAssessment[] = [
    resolved, { ...resolved, config: { ...config, characterization } }, { ...resolved, config: { ...config, setupSeconds: .48 * ns } },
    { ...resolved, config: { ...config, holdSeconds: .49 * ns } }, { ...resolved, config: { ...config, sampleOffsetSeconds: .1 * ns, direction: 'read' } },
    { ...resolved, eye: { ...resolved.eye, startTimeSeconds: 1.45 * ns } },
    { ...resolved, config: { ...config, thresholds: { ...config.thresholds, vihAcV: .8 } } },
  ]
  let compared = 0
  for (const r of rows) for (const v of variants) { see('assess', outcome(() => assessDdr(r, v))); compared++ }
  assert.equal(compared, rows.length * variants.length)
}))

test('golden: resolveDdrAssessments and validateDdrConfig equal the pre-module binding and its errors', () => golden('resolve', see => {
  const plan = { name: 'switching', simulationExperimentId: 'run', probes: [resolved.data, resolved.strobe], eyes: [resolved.eye],
    states: ['dq', 'dqs', 'dqsn'].map(source_port_id => ({ source_port_id, is_output: false })) } as SimulationPlan
  const geometry = { mappings: ['dq', 'dqs', 'dqsn'].map(to => ({ to })) } as Geometry
  const cases: [SimulationPlan[], unknown][] = [
    [[plan], [config]], [[plan], undefined], [[plan], {}], [[plan], [{ ...config, strobeProbe: 'TX' }]],
    [[{ ...plan, probes: [resolved.data, { ...resolved.strobe, signalSourceId: 'tx' }] }], [config]],
    [[{ ...plan, states: [] }], [config]], [[{ ...plan, eyes: [] }], [config]],
    [[plan], [{ ...config, maximumStrobeIntervalErrorSeconds: ns }]], [[plan], [{ ...config, experimentNames: ['typo'] }]],
    [[plan], [config, { ...config, name: 'duplicate eye' }]], [[plan], [config, config]], [[plan, { ...plan, name: 'quiet', simulationExperimentId: 'quiet' }], [config]],
    [[plan], [{ ...config, dataProbe: 'DQS_DIFF' }]], [[plan], [{ ...config, characterization: { ...characterization, referencePlane: 'die' } }]], [[plan], [null]],
  ]
  for (const [plans, configs] of cases) see('resolve', outcome(() => resolveDdrAssessments(plans, geometry, configs as never)))
  for (const c of [config, { ...config, vrefV: Infinity }, { ...config, experimentNames: [] }, { ...config, direction: 'both' }])
    see('validate', outcome(() => validateDdrConfig(c as never)))
}))

test('status rule (kept as today): a strobe-gate failure yields not-evaluated, never violated', () => {
  const ringing = waveform({ extra: [2.62, 2.66, 2.7] })
  ringing.find(r => Math.abs(r[0] / ns - 2.66) < 1e-12)![2] = -1
  const result = assessDdr(ringing, resolved)
  assert.equal(result.strobe.status, 'violated')
  assert.equal(result.status, 'not-evaluated')
  assert.equal(result.checks.status, 'not-evaluated')
})
