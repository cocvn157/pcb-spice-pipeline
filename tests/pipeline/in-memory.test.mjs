// Moved from tests/in-memory.test.mjs; imports repointed to the new modules. Assertions unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {runPipeline} from '../../src/index.js'
import {inMemoryInput,fixtureSolver} from '../fixtures/in-memory.mjs'

test('cold public import, complete pipeline and report work with implicit host actions denied',()=>{
  const input=inMemoryInput();input.ibisSources=Object.fromEntries(Object.entries(input.ibisSources).map(([path,bytes])=>[path,bytes.toString('utf8')]))
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../denied-host.mjs',import.meta.url))],{encoding:'utf8',input:JSON.stringify(input)})
  assert.equal(result.status,0,result.stderr)
})
test('transient diagnostics and missing, truncated or nonfinite samples fail even after valid matrices',async()=>{
  const input=inMemoryInput()
  for(const [output,code] of [
    [{stdout:'Error: transient simulation aborted',stderr:'',files:{'waveform.dat':'time a b\n0 0 0\n.00001 1 1\n'}},'native_solver'],
    [{stdout:'',stderr:'',files:{}},'native_output'],
    [{stdout:'',stderr:'',files:{'waveform.dat':'time a b\n0 0 0\n.000001 1 1\n'}},'simulation_duration'],
    [{stdout:'',stderr:'',files:{'waveform.dat':'time a b\n0 NaN 0\n.00001 1 1\n'}},'waveform'],
  ]) await assert.rejects(runPipeline({...input,runSolver:request=>request.solver==='ngspice'?Promise.resolve(output):fixtureSolver(request)}),error=>error.code===code)
})
