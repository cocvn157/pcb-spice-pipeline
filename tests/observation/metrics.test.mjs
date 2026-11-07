// Copied from tests/metrics.test.mjs (foldProbeEye half of the budget test; measureWaveform/foldEye are legacy, not ported).
import test from 'node:test'
import assert from 'node:assert/strict'
import {foldProbeEye} from '../../src/observation/index.js'

test('eye budgets reject window and sample amplification before interpolation',()=>{
  const rows=[[0,0],[5,1]],eye={name:'bounded',column:1,unitIntervalSeconds:1,timeOriginSeconds:.5,startTimeSeconds:0,endTimeSeconds:5}
  for(const fold of [
    (points,limits,ui=1)=>foldProbeEye(rows,{...eye,unitIntervalSeconds:ui},{pointsPerWindow:points,limits}),
  ]) {
    assert.throws(()=>fold(2,{maxWindows:3}),/eye_budget.*windows/)
    assert.throws(()=>fold(3,{maxSamples:11}),/eye_budget.*samples/)
    assert.throws(()=>fold(1e9),/eye_budget.*samples/)
    assert.throws(()=>fold(2,undefined,1e-8),/eye_budget.*windows/)
    assert.throws(()=>fold(2,undefined,1e-20),/eye_budget/)
    assert.throws(()=>fold(2,{maxSamples:Infinity}),/eye_budget/)
    const result=fold(3,{maxWindows:4,maxSamples:12})
    assert.equal(result.windows,4)
    assert.equal(result.samples.length,12)
  }
})
