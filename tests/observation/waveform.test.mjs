// Copied from tests/general.test.mjs (the probeWaveformRows test; its foldProbeEye test lives in fold.test.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import {probeWaveformRows} from '../../src/observation/index.js'

test('recorded probe columns remain bound and finite timestamps strictly increase',()=>{
  assert.deepEqual(probeWaveformRows('time a b\n0 1 2\n.3 1.2 2.3\n',[{},{}]),[[0,1,2],[.3,1.2,2.3]])
  assert.throws(()=>probeWaveformRows('time a\n0 1\n0 2\n',[{}]),/strictly increase/)
  assert.throws(()=>probeWaveformRows('time a\n0 NaN\n',[{}]),/finite/)
})
