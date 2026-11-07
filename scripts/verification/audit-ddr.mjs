// Independently verify received-DQS folding against raw waveform observations.
// This audits recorded numerical evidence, not device characterization/compliance.
import assert from 'node:assert/strict'
import { close, interpolate } from './independent-helpers.mjs'

export function receivedDqsWindows(rows, probes, eye, configs) {
  const assessment = eye.ddrAssessment
  const c = assessment.config
  assert.deepEqual(c, configs.find(config => config.name === assessment.name), 'DDR limits match captured modeling configuration')
  assert.equal(assessment.compliance.status, 'not-evaluated', 'Finite eye never establishes compliance')
  assert.ok(['illustrative', 'within-characterized-limits', 'violated', 'not-evaluated'].includes(assessment.status))
  if (!c.characterization) assert.notEqual(assessment.status, 'within-characterized-limits')
  const data = probes.find(p => p.name === c.dataProbe)
  const strobe = probes.find(p => p.name === c.strobeProbe)
  assert.equal(data.simulationVoltageProbeId, eye.simulationVoltageProbeId)
  const times = rows.map(r => r[0])
  const values = rows.map(r => r[strobe.column])
  const crossings = []
  // Consecutive nonzero observations bracket a crossing; exact-zero samples are
  // retained, and two or more exact-zero samples make its timing ambiguous.
  const nonzero = rows.map((r, i) => i).filter(i => values[i] !== 0)
  for (let k = 1; k < nonzero.length; k++) {
    const a = nonzero[k - 1]
    const b = nonzero[k]
    if (Math.sign(values[a]) === Math.sign(values[b])) continue
    const time = b > a + 1 ? times[a + 1] : times[a] + (times[b] - times[a]) * Math.abs(values[a]) / Math.abs(values[b] - values[a])
    if (time >= eye.startTimeSeconds && time <= eye.endTimeSeconds) crossings.push({ time, rising: values[b] > 0, ambiguous: b > a + 2 })
  }
  assert.equal(assessment.strobe.crossingsSeconds.length, crossings.length)
  crossings.forEach((e, i) => close(assessment.strobe.crossingsSeconds[i], e.time, 'Received zero-crossing interpolation', 1e-9, 1e-20))
  if (assessment.strobe.status !== 'within-configured-limits') {
    assert.equal(assessment.status, 'not-evaluated', 'Unusable DQS cannot satisfy DDR checks')
    assert.deepEqual(assessment.captureTimesSeconds, [])
    return []
  }
  assert.ok(crossings.length >= 2)
  for (const [i, edge] of crossings.entries()) {
    assert.equal(edge.ambiguous, false)
    if (i) assert.ok(Math.abs(edge.time - crossings[i - 1].time - eye.unitIntervalSeconds) <= c.maximumStrobeIntervalErrorSeconds)
    const bounds = [i ? crossings[i - 1].time : Math.max(times[0], edge.time - eye.unitIntervalSeconds), edge.time,
      i + 1 < crossings.length ? crossings[i + 1].time : Math.min(times.at(-1), edge.time + eye.unitIntervalSeconds)]
    for (let side = 0; side < 2; side++) {
      const start = bounds[side]
      const end = bounds[side + 1]
      const sign = (edge.rising ? 1 : -1) * (side ? 1 : -1)
      const lobe = [interpolate(times, values, start), interpolate(times, values, end), ...values.filter((_, j) => times[j] > start && times[j] < end)]
      assert.ok(lobe.some(v => sign * v >= c.minimumStrobeDifferentialV), 'Actual differential lobe reaches explicit magnitude')
    }
  }
  for (let i = 1; i < values.length - 1; i++) if (values[i] === 0 && times[i] >= eye.startTimeSeconds && times[i] <= eye.endTimeSeconds)
    assert.ok(values[i - 1] * values[i + 1] < 0, 'Every exact zero is an isolated sign crossing, not a tangency/plateau')
  assert.equal(assessment.captureTimesSeconds.length, crossings.length)
  assert.equal(assessment.captures.length, crossings.length)
  crossings.forEach((edge, i) => {
    const expected = edge.time + c.sampleOffsetSeconds
    const capture = assessment.captures[i]
    close(assessment.captureTimesSeconds[i], expected, 'Received sampling time', 1e-9, 1e-20)
    close(capture.sampleTimeSeconds, expected, 'Per-edge sampling time', 1e-9, 1e-20)
    if (capture.voltageV !== null) close(capture.voltageV, interpolate(times, rows.map(r => r[data.column]), expected), 'Actual DQ voltage at received capture', 1e-9, 1e-12)
    if (capture.status === 'within-configured-limits') {
      assert.ok(capture.setupMarginSeconds >= 0 && capture.holdMarginSeconds >= 0 && capture.dcMarginV >= 0)
      assert.ok(expected - c.setupSeconds >= eye.startTimeSeconds && expected + c.holdSeconds <= eye.endTimeSeconds)
      const dq = rows.map(r => r[data.column])
      const sign = capture.level === 'high' ? 1 : -1
      const dc = capture.level === 'high' ? c.thresholds.vihDcV : c.thresholds.vilDcV
      const ac = capture.level === 'high' ? c.thresholds.vihAcV : c.thresholds.vilAcV
      const setup = expected - c.setupSeconds
      const hold = expected + c.holdSeconds
      const aperture = [interpolate(times, dq, setup), interpolate(times, dq, hold), ...dq.filter((_, j) => times[j] > setup && times[j] < hold)]
      assert.ok(aperture.every(v => sign * (v - dc) >= -1e-12), 'Actual DQ remains DC-valid throughout setup and hold')
      const invalid = times.findLastIndex((t, j) => t < expected && sign * (dq[j] - dc) < 0)
      const qualified = [interpolate(times, dq, setup), ...dq.filter((_, j) => j > invalid && times[j] <= setup)]
      assert.ok(qualified.some(v => sign * (v - ac) >= -1e-12), 'Actual AC acquisition precedes the required setup aperture')
    }
  })
  return crossings.map(e => ({ start: e.time + c.sampleOffsetSeconds - eye.unitIntervalSeconds,
    end: e.time + c.sampleOffsetSeconds + eye.unitIntervalSeconds })).filter(w => w.start >= eye.startTimeSeconds && w.end <= eye.endTimeSeconds)
}
