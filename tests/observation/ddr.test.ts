// Copied from tests/ddr.test.ts: the received-alignment fold assertion that does not need assessDdr
// (the others fold assessDdr output; the ddr module's tests own those, golden.test.ts covers the path here).
import test from 'node:test'
import assert from 'node:assert/strict'
import { foldProbeEye, type EyeGate } from '../../src/observation'

const ns = 1e-9
const resolved: { eye: EyeGate } = {
  eye: { name: 'DQ eye', column: 1, unitIntervalSeconds: ns, timeOriginSeconds: 0, startTimeSeconds: ns, endTimeSeconds: 9 * ns },
}

test('quiet or insufficient differential strobe never passes and produces no received eye windows', () => {
  const sparse = foldProbeEye([[0, 0], [10 * ns, 10]], resolved.eye, { alignment: { kind: 'received-differential-dqs', captureTimesSeconds: [] }, pointsPerWindow: 5 })
  sparse.metrics.voltageRangeV.forEach((v: number, i: number) => assert.ok(Math.abs(v - [1, 9][i]) < 1e-12,
    'range includes interpolated gate boundaries even with no interior solver samples'))
  assert.equal(sparse.windows, 0)
  assert.equal(sparse.metrics.alignment, 'received-differential-dqs')
  assert.equal(sparse.metrics.timeOriginSeconds, null)
})
