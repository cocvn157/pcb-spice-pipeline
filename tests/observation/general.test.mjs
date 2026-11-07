// Copied from tests/general.test.mjs (the two tests exercising foldProbeEye/probeWaveformRows).
import test from 'node:test'
import assert from 'node:assert/strict'
import {foldProbeEye as fold,probeWaveformRows} from '../../src/observation/index.js'
const foldProbeEye=(rows,eye,pointsPerWindow)=>fold(rows,eye,{pointsPerWindow})

test('fixed eye origin/gates fold irregular timestamps and repeated levels without clock parity',()=>{
  const rows=[[0,0],[.2,0],[.7,1],[1.4,1],[1.8,1],[2.2,-.3],[2.8,0],[3.6,0],[4.4,1],[5,1]],eye={name:'data',column:1,unitIntervalSeconds:1,timeOriginSeconds:.25,startTimeSeconds:0,endTimeSeconds:5}
  const result=foldProbeEye(rows,eye,5)
  assert.deepEqual(result.windowOriginsSeconds,[.75,1.75,2.75])
  assert.deepEqual(result.boundaryIndices,[1,2,3])
  assert.equal(result.samples.length,15)
  assert.deepEqual(result.windowOriginsSeconds,foldProbeEye(rows.map(([time,v])=>[time,-v]),eye,5).windowOriginsSeconds)
  assert.deepEqual(foldProbeEye(rows.map(([time])=>[time,3.3]),eye,5).metrics.voltageRangeV,[3.3,3.3],'constant drive is a valid observed voltage waveform')
  const sample=result.samples[0],fraction=(sample[2]-.7)/(1.4-.7)
  assert.equal(sample[3],rows[2][1]+(rows[3][1]-rows[2][1])*fraction)
  assert.throws(()=>foldProbeEye(rows,{...eye,startTimeSeconds:4.5},5),/no complete/)
})

test('recorded probe columns remain bound and finite timestamps strictly increase',()=>{
  assert.deepEqual(probeWaveformRows('time a b\n0 1 2\n.3 1.2 2.3\n',[{},{}]),[[0,1,2],[.3,1.2,2.3]])
  assert.throws(()=>probeWaveformRows('time a\n0 1\n0 2\n',[{}]),/strictly increase/)
  assert.throws(()=>probeWaveformRows('time a\n0 NaN\n',[{}]),/finite/)
})
