// Copied from tests/eyediagram.test.mjs (foldProbeEye tests only; eyeSimulation/resolveEyeDiagram/
// measureWaveform/foldEye are legacy two-lane clock-eye code and were not ported).
import test from 'node:test'
import assert from 'node:assert/strict'
import {foldProbeEye as fold} from '../../src/observation/index.js'
const foldProbeEye=(rows,eye,pointsPerWindow,limits)=>fold(rows,eye,{pointsPerWindow,limits})

test('empty eye gate reports timing and skipped UIs instead of an empty eye',()=>{
  const eye={name:'DQ0',column:1,unitIntervalSeconds:2.5e-9,timeOriginSeconds:0,
    startTimeSeconds:40e-9,endTimeSeconds:45e-9}
  const rows=[[0,0],[40e-9,1],[45e-9,0]]
  assert.throws(()=>foldProbeEye(rows,eye,5),error=>{
    assert.equal(error.code,'eye_windows')
    assert.match(error.message,/DQ0: no complete two-UI windows/)
    assert.ok(error.message.includes(`gate [${eye.startTimeSeconds}, ${eye.endTimeSeconds}] s`))
    assert.ok(error.message.includes(`UI ${eye.unitIntervalSeconds} s`))
    assert.match(error.message,/skip 16 UI/)
    return true
  })
})

test('two-UI eye windows center half a UI after stimulus bit boundaries',()=>{
  const ui=2.5e-9,origin=1.25e-9
  const eye={name:'DQ0',column:1,unitIntervalSeconds:ui,timeOriginSeconds:origin,
    startTimeSeconds:origin+16*ui,endTimeSeconds:origin+20*ui}
  // A ramp makes interpolated voltage equal absolute time, independent of bit levels.
  const folded=foldProbeEye([[0,0],[100e-9,100e-9]],eye,5)
  assert.deepEqual(folded.boundaryIndices,[17,18])
  assert.equal(folded.windows,2)
  for(const [window,offset,time,value] of folded.samples) {
    const boundary=origin+folded.boundaryIndices[window]*ui
    assert.ok(Math.abs(time-(boundary-ui/2+offset))<1e-22)
    assert.ok(Math.abs(value-time)<1e-22)
    if(offset===ui) assert.ok(Math.abs(time-(boundary+ui/2))<1e-22)
  }
})

test('aligned nanosecond gates tolerate floating-point roundoff at either boundary',()=>{
  for(const scale of [1e-3,1,1e3]) {
    // Match the native ns -> Circuit JSON ms -> seconds conversion.
    const ui=2.5*1e-6/1000*scale,start=41.25e-9*scale,end=46.250001e-9*scale
    const eye={name:'DQ0',column:1,unitIntervalSeconds:ui,timeOriginSeconds:0,
      startTimeSeconds:start,endTimeSeconds:end}
    const folded=foldProbeEye([[0,0],[100e-9*scale,100e-9*scale]],eye,5)
    assert.deepEqual(folded.boundaryIndices,[17])
    assert.equal(folded.windows,1)
    for(const [,,time,value] of folded.samples) assert.ok(Math.abs(value-time)<ui*1e-12)
    // Rounding at the end of a recorded waveform must also preserve the window.
    assert.equal(foldProbeEye([[start,0],[start+2*ui,1]],{...eye,endTimeSeconds:start+2*ui},5).windows,1)
    assert.throws(()=>foldProbeEye([[0,0],[100e-9*scale,0]],{...eye,startTimeSeconds:start+ui*1e-6},5),/eye_windows/)
    assert.throws(()=>foldProbeEye([[0,0],[100e-9*scale,0]],{...eye,endTimeSeconds:start+2*ui-ui*1e-6},5),/eye_windows/)
  }
})
