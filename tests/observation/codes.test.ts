// Every code in src/observation/diagnostics.ts, raised with today's message (module rule M3).
import test from 'node:test'
import assert from 'node:assert/strict'
import { Diagnostic } from '../../src/kernel/index.js'
import { foldProbeEye, probeWaveformRows } from '../../src/observation/index.js'

const rows = [[0, 0], [5, 1]], eye = { name: 'e', column: 1, unitIntervalSeconds: 1, timeOriginSeconds: .5, startTimeSeconds: 0, endTimeSeconds: 5 }
const diag = (code: string, message: string) => (e: unknown) => {
  assert.ok(e instanceof Diagnostic); assert.equal(e.domain, 'observation')
  assert.deepEqual({ code: e.code, message: e.message }, { code, message: `${code}: ${message}` }); return true
}

test('observation diagnostics keep codes and messages', () => {
  assert.throws(() => probeWaveformRows('time a\n', [{}]), { code: 'waveform' })
  assert.throws(() => probeWaveformRows('time a\n0 1 2\n', [{}]), diag('waveform', 'Expected actual time and one finite column per declared probe'))
  assert.throws(() => probeWaveformRows('time a\r\n1 1\r\n0 1\r\n', [{}]), diag('waveform', 'Actual solver timestamps must strictly increase'))
  assert.throws(() => foldProbeEye(rows, eye, { pointsPerWindow: 1 }), { code: 'eye_resolution' })
  assert.throws(() => foldProbeEye(rows, eye, { pointsPerWindow: 1.5 }), diag('eye_resolution', 'At least two plotting points per window required'))
  assert.throws(() => foldProbeEye(rows, { ...eye, unitIntervalSeconds: 0 }), { code: 'eye_timing' })
  assert.throws(() => foldProbeEye(rows, { ...eye, timeOriginSeconds: NaN }), diag('eye_timing', 'e: positive UI and finite timeOrigin required'))
  assert.throws(() => foldProbeEye(rows, eye, { alignment: { kind: 'received-differential-dqs', captureTimesSeconds: [2, 2] } }),
    diag('eye_timing', 'Received capture times must be finite and strictly increasing'))
  assert.throws(() => foldProbeEye(rows, { ...eye, column: 2 }), { code: 'eye_probe' })
  assert.throws(() => foldProbeEye(rows, { ...eye, column: 0 }), diag('eye_probe', 'e: missing recorded probe column'))
  assert.throws(() => foldProbeEye(rows, { ...eye, startTimeSeconds: 4 }), { code: 'eye_windows' })
  assert.throws(() => foldProbeEye(rows, { ...eye, startTimeSeconds: 4 }),
    diag('eye_windows', 'e: no complete two-UI windows within measurement gate [4, 5] s; UI 1 s; skip 3.5 UI from timeOrigin 0.5 s; recorded timestamps [0, 5] s'))
  assert.throws(() => foldProbeEye(rows, eye, { limits: { maxWindows: 0 } }), { code: 'eye_budget' })
  assert.throws(() => foldProbeEye(rows, eye, { limits: { maxWindows: 0 } }), diag('eye_budget', 'Eye limits must be positive safe integers'))
  assert.throws(() => foldProbeEye(rows, eye, { limits: { maxWindows: 3 } }), diag('eye_budget', 'Eye windows exceed the limit of 3 or have unsafe boundary indices'))
  assert.throws(() => foldProbeEye(rows, eye, { pointsPerWindow: 5, limits: { maxSamples: 19 } }), diag('eye_budget', 'Eye plotted samples exceed the limit of 19'))
  assert.throws(() => foldProbeEye([[0, 0], [3.5 - 5e-10, 1]], { ...eye, timeOriginSeconds: 0, endTimeSeconds: 10 }, { pointsPerWindow: 5 }), { code: 'eye_interpolation' })
})
