// Was src/ddr.ts. Behaviour, messages and the status rule are unchanged. Open question (ARCHITECTURE.md):
// a strobe-gate failure makes the overall status 'not-evaluated' rather than 'violated'; kept as today.
import { fail } from './diagnostics'
import type { Geometry } from '../board'
import type { SimulationPlan, VoltageProbePlan } from '../simulation'
import type { DdrAssessment, DdrAssessmentConfig, DdrCapture, ResolvedDdrAssessment } from './types'

/** Reject a DDR config unless every name, limit and threshold is explicit, finite and correctly ordered; limits are never inferred. */
export function validateDdrConfig(c: DdrAssessmentConfig): void {
  if (!c || typeof c !== 'object') fail('ddr_config', 'Explicit DDR assessment configuration required')
  /** Fail with a ddr_config diagnostic unless `value` is a finite number at or above `minimum`. */
  const finite = (value: unknown, field: string, minimum: number = -Infinity): void => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) fail('ddr_config', `${c.name}: explicit finite ${field} required (minimum ${minimum})`)
  }
  if (![c.name, c.dataProbe, c.strobeProbe].every(v => typeof v === 'string' && v.trim()) || c.dataProbe === c.strobeProbe)
    fail('ddr_config', 'DDR name and distinct dataProbe/strobeProbe names are required')
  if (!['read', 'write'].includes(c.direction)) fail('ddr_config', `${c.name}: explicit read/write direction required`)
  finite(c.sampleOffsetSeconds, 'sampleOffsetSeconds')
  finite(c.vrefV, 'vrefV')
  finite(c.setupSeconds, 'setupSeconds', 0)
  finite(c.holdSeconds, 'holdSeconds', 0)
  finite(c.minimumStrobeDifferentialV, 'minimumStrobeDifferentialV', Number.MIN_VALUE)
  finite(c.maximumStrobeIntervalErrorSeconds, 'maximumStrobeIntervalErrorSeconds', 0)
  for (const key of ['vilAcV', 'vilDcV', 'vihDcV', 'vihAcV'] as const) finite(c.thresholds?.[key], `thresholds.${key}`)
  const { vilAcV, vilDcV, vihDcV, vihAcV } = c.thresholds
  if (!(vilAcV < vilDcV && vilDcV < c.vrefV && c.vrefV < vihDcV && vihDcV < vihAcV))
    fail('ddr_config', `${c.name}: require VIL(AC) < VIL(DC) < VREF < VIH(DC) < VIH(AC)`)
  if (c.experimentNames !== undefined && (!Array.isArray(c.experimentNames) || !c.experimentNames.length || c.experimentNames.some(n => typeof n !== 'string' || !n.trim())))
    fail('ddr_config', `${c.name}: experimentNames must contain explicit experiment names`)
  if (c.characterization && (c.characterization.referencePlane !== 'receiver-pad' ||
    ['source', 'receiver', 'speedGrade', 'conditions', 'derating'].some(key => typeof Reflect.get(c.characterization!, key) !== 'string' || !Reflect.get(c.characterization!, key).trim())))
    fail('ddr_config', `${c.name}: characterization requires source, receiver, speedGrade, conditions, derating and receiver-pad referencePlane`)
}

/** Bind existing native probes/eyes without adding unsupported TSX properties. */
export function resolveDdrAssessments(plans: SimulationPlan[], geometry: Geometry, configs: DdrAssessmentConfig[] = []): ResolvedDdrAssessment[] {
  if (!Array.isArray(configs)) fail('ddr_config', 'modeling.ddrAssessments must be an array')
  const resolved: ResolvedDdrAssessment[] = []
  const selected = new Set<string>()
  const names = new Set<string>()
  for (const config of configs) {
    validateDdrConfig(config)
    if (names.has(config.name)) fail('ddr_config', `Duplicate DDR assessment name ${config.name}`)
    names.add(config.name)
    for (const name of config.experimentNames ?? []) if (!plans.some(p => p.name === name)) fail('ddr_config', `${config.name}: unknown experiment ${name}`)
    for (const plan of plans.filter(p => !config.experimentNames || config.experimentNames.includes(p.name))) {
      /** Look up the single native voltage probe of this plan with the given name; anything else is a ddr_probe error. */
      const probe = (name: string): VoltageProbePlan => {
        const matches = plan.probes.filter(p => p.name === name)
        if (matches.length !== 1) fail('ddr_probe', `${plan.name}: ${name} must select exactly one native voltage probe`)
        return matches[0]
      }
      const data = probe(config.dataProbe)
      const strobe = probe(config.strobeProbe)
      const ids = [data.signalSourceId, strobe.signalSourceId, strobe.referenceSourceId]
      if (new Set(ids).size !== 3 || !ids.every(id => geometry.mappings.some(m => m.to === id)) || data.referenceNode !== '0')
        fail('ddr_probe', `${config.name}: require ground-referenced DQ and differential DQS/DQSn at three distinct extracted receiver pads`)
      if (ids.some(id => !plan.states.some(s => s.source_port_id === id && s.is_output === false)))
        fail('ddr_probe', `${config.name}: each receiving pad must have an explicit input state`)
      const eyes = plan.eyes.filter(e => e.simulationVoltageProbeId === data.simulationVoltageProbeId)
      if (eyes.length !== 1) fail('ddr_probe', `${config.name}: dataProbe must have exactly one native eye per selected experiment`)
      const eye = eyes[0]
      const key = `${plan.simulationExperimentId}/${eye.simulationEyeDiagramId}`
      if (selected.has(key)) fail('ddr_config', `${config.name}: duplicate assessment for the same data eye`)
      selected.add(key)
      if (config.maximumStrobeIntervalErrorSeconds >= eye.unitIntervalSeconds / 2)
        fail('ddr_config', `${config.name}: strobe interval tolerance must be less than half a UI`)
      resolved.push({ config, data, strobe, eye })
    }
  }
  return resolved
}

// Piecewise-linear operations use actual adaptive timestamps, never nearest samples.
/** Binary-search the index of the first row whose time is at or after `time` (clamped to the last row). */
function lowerBound(rows: number[][], time: number): number {
  let lo = 0
  let hi = rows.length - 1
  while (lo < hi) {
    const m = (lo + hi) >>> 1
    if (rows[m][0] < time) lo = m + 1
    else hi = m
  }
  return lo
}
/** Linearly interpolate a column's voltage at `time` between the recorded rows around it. */
function voltage(rows: number[][], column: number, time: number): number {
  const i = lowerBound(rows, time)
  const b = rows[i]
  const a = rows[Math.max(0, i - 1)]
  return a[0] === b[0] ? b[column] : a[column] + (b[column] - a[column]) * (time - a[0]) / (b[0] - a[0])
}
/** The piecewise-linear trace of one column over [start, end]: interpolated endpoints plus every recorded row strictly inside. */
function points(rows: number[][], column: number, start: number, end: number): number[][] {
  const out = [[start, voltage(rows, column, start)]]
  for (let i = lowerBound(rows, start); i < rows.length && rows[i][0] < end; i++) if (rows[i][0] > start) out.push([rows[i][0], rows[i][column]])
  out.push([end, voltage(rows, column, end)])
  return out
}
/**
 * Find the sign changes of a differential column (interpolated crossing times, with polarity) and the
 * zero-touch spans that make a crossing ambiguous, so strobe edges are never guessed through a plateau.
 */
function zeroCrossings(rows: number[][], column: number): { edges: { time: number; rising: boolean; plateau: boolean }[]; ambiguities: { start: number; end: number }[] } {
  const edges: { time: number; rising: boolean; plateau: boolean }[] = []
  const ambiguities: { start: number; end: number }[] = []
  let previous = -1
  let firstZero: number | undefined
  let lastZero: number | undefined
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i][column]
    if (v === 0) {
      firstZero ??= rows[i][0]
      lastZero = rows[i][0]
      continue
    }
    if (firstZero !== undefined && (firstZero !== lastZero || (previous >= 0 && Math.sign(rows[previous][column]) === Math.sign(v))))
      ambiguities.push({ start: firstZero, end: lastZero! })
    if (previous >= 0 && rows[previous][column] * v < 0) {
      const a = rows[previous]
      const b = rows[i]
      edges.push({ time: firstZero ?? a[0] - a[column] * (b[0] - a[0]) / (v - a[column]), rising: v > 0, plateau: firstZero !== lastZero })
    }
    previous = i
    firstZero = lastZero = undefined
  }
  if (firstZero !== undefined) ambiguities.push({ start: firstZero, end: lastZero! })
  return { edges, ambiguities }
}

/** Assess one resolved DQ/DQS pair against its configured limits: check the received strobe train, then classify each capture's DC margin and setup/hold. */
export function assessDdr(rows: number[][], { config: c, data, strobe, eye }: ResolvedDdrAssessment): DdrAssessment {
  validateDdrConfig(c)
  const result: DdrAssessment = {
    name: c.name, status: 'not-evaluated', config: c, dataProbe: data.name, strobeProbe: strobe.name,
    alignment: 'received-differential-dqs', checks: { status: 'not-evaluated', captures: 0, violations: 0, unevaluated: 0 },
    compliance: { status: 'not-evaluated', reason: 'Finite selected-lane simulation cannot establish DDR/JEDEC or board compliance, even when configured checks are satisfied.' },
    strobe: { status: 'not-evaluated', crossingsSeconds: [] }, captureTimesSeconds: [], captures: [], reasons: [],
    limitations: [
      'Receiver-pad voltages only; no inferred internal receiver timing, training or package de-embedding.',
      `Both polarities of received differential DQS zero crossings plus explicit sample offset ${c.sampleOffsetSeconds} s; no transmit-clock phase substitution.`,
      `Explicit constant VREF ${c.vrefV} V relative to DQ probe ground; VREF noise and drift are not modeled.`,
      'Setup starts at the first AC-threshold attainment after the latest DC-invalid excursion; DC validity must continue through capture and hold. Capture-boundary timing values are lower bounds.',
      'Linear interpolation of recorded adaptive timestamps cannot bound unresolved ringing or integration error; display sample count does not establish convergence.',
      'Observed high/low levels are inferred from received voltage, not checked against transmitted bits; no bit correctness or BER claim.',
      'No full-bus, command/address, common-mode, overshoot/undershoot, pulse-width, slew-rate derating, PVT, firmware or hardware validation is performed.',
      c.characterization ? 'Characterized limit evidence is user-supplied and has not been independently verified.' : 'Illustrative explicit limits only: no characterized receiver, speed grade, conditions or timing derating evidence supplied.',
    ],
  }
  /** Record why the strobe could not be evaluated and return the assessment as it stands. */
  const unavailable = (reason: string): DdrAssessment => {
    result.reasons.push(reason)
    result.strobe.reason = reason
    return result
  }
  if (rows.length < 2 || rows.some((r, i) => [0, data.column, strobe.column].some(col => !Number.isFinite(r[col])) || (i > 0 && r[0] <= rows[i - 1][0])))
    return unavailable('Missing, nonfinite or nonmonotonic recorded waveform.')
  const start = eye.startTimeSeconds
  const end = eye.endTimeSeconds
  const ui = eye.unitIntervalSeconds
  if (rows[0][0] > start || rows.at(-1)![0] < end) return unavailable('Incomplete capture: the recorded waveform does not cover the entire requested gate.')
  const observed = zeroCrossings(rows, strobe.column)
  const edges = observed.edges.filter(e => e.time >= start && e.time <= end)
  result.strobe.crossingsSeconds = edges.map(e => e.time)
  if (edges.length < 2) return unavailable('No usable received DQS train: quiet or fewer than two differential crossings in the measurement gate.')
  if (edges.length > 10000) return unavailable('Received DQS train exceeds the 10000-edge analysis budget.')
  const tolerance = c.maximumStrobeIntervalErrorSeconds
  if (observed.ambiguities.some(a => a.end >= start && a.start <= end) || edges.some((e, i) => e.plateau || (i > 0 && Math.abs(e.time - edges[i - 1].time - ui) > tolerance)) ||
    edges[0].time - start > ui + tolerance || end - edges.at(-1)!.time > ui + tolerance) {
    result.strobe.status = 'violated'
    return unavailable('Ambiguous, extra or missing received DQS crossings (ringing, zero touch/plateau or interval outside configured UI tolerance).')
  }
  // Require full signed lobes on both sides of every crossing; never hide a recrossing.
  if (edges.some((e, i) => {
    const before = points(rows, strobe.column, i ? edges[i - 1].time : Math.max(rows[0][0], e.time - ui), e.time)
    const after = points(rows, strobe.column, e.time, i + 1 < edges.length ? edges[i + 1].time : Math.min(rows.at(-1)![0], e.time + ui))
    return !before.some(p => (e.rising ? -p[1] : p[1]) >= c.minimumStrobeDifferentialV) || !after.some(p => (e.rising ? p[1] : -p[1]) >= c.minimumStrobeDifferentialV)
  })) return unavailable('Received DQS does not reach the configured differential magnitude on both sides of every crossing.')
  result.strobe.status = 'within-configured-limits'
  for (const edge of edges) {
    const time = edge.time + c.sampleOffsetSeconds
    const capture: DdrCapture = { strobeTimeSeconds: edge.time, sampleTimeSeconds: time, rising: edge.rising, voltageV: null, level: 'indeterminate', status: 'not-evaluated' }
    result.captures.push(capture)
    if (time - c.setupSeconds < start || time + c.holdSeconds > end) {
      capture.reason = 'Setup/hold aperture is outside the measurement gate.'
      continue
    }
    const value = voltage(rows, data.column, time)
    const high = value > c.vrefV
    const sign = high ? 1 : -1
    capture.voltageV = value
    const dc = high ? c.thresholds.vihDcV : c.thresholds.vilDcV
    const ac = high ? c.thresholds.vihAcV : c.thresholds.vilAcV
    capture.dcMarginV = sign * (value - dc)
    if (capture.dcMarginV < 0) {
      capture.status = 'violated'
      capture.reason = 'DQ is inside the DC-invalid voltage band at capture.'
      continue
    }
    capture.level = high ? 'high' : 'low'
    // Find the contiguous DC-valid region containing this capture. Re-entry after
    // ringing resets setup qualification; recrossing only AC does not reset it.
    let left = lowerBound(rows, time) - 1
    let right = lowerBound(rows, time)
    while (left >= 0 && sign * (rows[left][data.column] - dc) >= 0) left--
    while (right < rows.length && sign * (rows[right][data.column] - dc) >= 0) right++
    /** Interpolated time at which the segment from row `a` to row `b` crosses the DC threshold. */
    const boundary = (a: number[], b: number[]): number => a[0] + (dc - a[data.column]) * (b[0] - a[0]) / (b[data.column] - a[data.column])
    const begin = left < 0 ? rows[0][0] : boundary(rows[left], rows[left + 1])
    const finish = right === rows.length ? rows.at(-1)![0] : boundary(rows[right - 1], rows[right])
    const preceding = points(rows, data.column, begin, time)
    const firstAc = preceding.findIndex(p => sign * (p[1] - ac) >= 0)
    capture.holdSeconds = finish - time
    capture.holdIsLowerBound = right === rows.length
    capture.holdMarginSeconds = capture.holdSeconds - c.holdSeconds
    if (firstAc < 0) {
      capture.status = 'violated'
      capture.reason = 'DQ never reaches its AC threshold in the current DC-valid interval.'
      continue
    }
    const b = preceding[firstAc]
    const a = preceding[Math.max(0, firstAc - 1)]
    const acquired = firstAc === 0 ? b[0] : a[0] + (ac - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
    capture.setupSeconds = time - acquired
    capture.setupIsLowerBound = firstAc === 0 && left < 0
    capture.setupMarginSeconds = capture.setupSeconds - c.setupSeconds
    capture.status = capture.setupMarginSeconds >= 0 && capture.holdMarginSeconds >= 0 ? 'within-configured-limits' : 'violated'
    if (capture.status === 'violated') capture.reason = 'Interpolated AC setup or DC hold time is below the explicit configured requirement.'
  }
  const violations = result.captures.filter(c => c.status === 'violated').length
  const unevaluated = result.captures.filter(c => c.status === 'not-evaluated').length
  result.checks = { status: violations ? 'violated' : unevaluated ? 'not-evaluated' : 'within-configured-limits', captures: result.captures.length, violations, unevaluated }
  result.status = violations ? 'violated' : unevaluated ? 'not-evaluated' : c.characterization ? 'within-characterized-limits' : 'illustrative'
  if (unevaluated) result.reasons.push('At least one received edge lacks a complete setup/hold aperture; incomplete evidence cannot satisfy the assessment.')
  result.captureTimesSeconds = result.captures.map(c => c.sampleTimeSeconds)
  return result
}
