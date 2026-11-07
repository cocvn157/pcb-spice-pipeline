// Ported from tests/in-memory.test.mjs, tests/transient-start.test.mjs and tests/transient-recovery.test.mjs:
// the ngspice acceptance rules, now runExperiment's (exercised through tests/simulation/compose.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import {compose} from './compose.ts'
import {inMemoryInput,fixtureSolver} from './fixtures.mjs'

test('transient diagnostics and missing, truncated or nonfinite samples fail even after valid matrices',async()=>{
  const input=inMemoryInput()
  for(const [output,code] of [
    [{stdout:'Error: transient simulation aborted',stderr:'',files:{'waveform.dat':'time a b\n0 0 0\n.00001 1 1\n'}},'native_solver'],
    [{stdout:'',stderr:'',files:{}},'native_output'],
    [{stdout:'',stderr:'',files:{'waveform.dat':'time a b\n0 0 0\n.000001 1 1\n'}},'simulation_duration'],
    [{stdout:'',stderr:'',files:{'waveform.dat':'time a b\n0 NaN 0\n.00001 1 1\n'}},'waveform'],
  ]) await assert.rejects(compose({...input,runSolver:request=>request.solver==='ngspice'?Promise.resolve(output):fixtureSolver(request)}),error=>error.code===code)
})

test('a transient missing its beginning fails before reporting partial eyes',async()=>{
  await assert.rejects(compose({...inMemoryInput(),runSolver:async request=>{
    const result=await fixtureSolver(request)
    if(request.solver==='ngspice') {
      const [header,...samples]=result.files['waveform.dat'].trim().split('\n')
      result.files['waveform.dat']=[header,...samples.slice(50)].join('\n')+'\n'
    }
    return result
  }}),error=>error.code==='simulation_start')
})

test('recovered operating-point warnings retain a complete finite transient',async()=>{
  const result=await compose({...inMemoryInput(),runSolver:async request=>({
    ...await fixtureSolver(request),stderr:request.solver==='ngspice'
      ?'Warning: singular matrix: check node xchan.s10_0\nWarning: True gmin stepping failed\nNote: Transient op started\n':'',
  })})
  assert.equal(result.experiments[0].waveform.rows.length,101)
})

test('a native_solver diagnostic names its experiment and log artifacts',async()=>{
  await assert.rejects(compose({...inMemoryInput(),runSolver:request=>request.solver==='ngspice'?Promise.resolve({stdout:'fatal: timestep too small',stderr:'',files:{'waveform.dat':'time a b\n0 0 0\n.00001 1 1\n'}}):fixtureSolver(request)}),
    error=>error.code==='native_solver'&&error.domain==='simulation'&&error.message==='native_solver: data: fatal: timestep too small'&&
      error.artifacts.includes('experiments/run/ngspice.stdout.log')&&error.subjects[0].id==='run')
})
