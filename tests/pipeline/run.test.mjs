// runPipeline end to end on the canned-solver fixtures. Moved from tests/in-memory.test.mjs,
// tests/pipeline-rerun.test.mjs and tests/solver-exit.test.mjs; imports repointed to the new modules. Assertions unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {runPipeline} from '../../src/index.js'
import {inMemoryInput,fixtureSolver} from '../fixtures/in-memory.mjs'

test('cold public import, complete pipeline and report work with implicit host actions denied',()=>{
  const input=inMemoryInput()
  input.ibisSources=Object.fromEntries(Object.entries(input.ibisSources).map(([path,bytes])=>[path,bytes.toString('utf8')]))
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

test('rerunning results replaces old graphs and preserves the physical input',async()=>{
  const input=inMemoryInput()
  const first=await runPipeline({...input,runSolver:fixtureSolver})
  const second=await runPipeline({...input,circuitJson:first.simulationResultCircuitJson,runSolver:async request=>{
    const result=await fixtureSolver(request)
    if(request.solver==='ngspice') result.files['waveform.dat']=result.files['waveform.dat'].trim().split('\n').map((line,index)=>
      index===0?line:line.split(' ').map((sample,column)=>column===0?sample:String(Number(sample)+5)).join(' ')).join('\n')+'\n'
    return result
  }})
  const graphs=second.simulationResultCircuitJson.filter(record=>record.type==='simulation_transient_voltage_graph')
  assert.equal(graphs.length,2)
  assert.equal(new Set(graphs.map(graph=>graph.simulation_transient_voltage_graph_id)).size,2)
  assert.ok(graphs.every(graph=>graph.voltage_levels.every(voltage=>voltage>=5)))
  assert.deepEqual(second.simulationResultCircuitJson.filter(record=>record.type!=='simulation_transient_voltage_graph'),input.circuitJson)
})

test('explicit nonzero solver exits reject even when the returned matrices look valid',async()=>{
  await assert.rejects(runPipeline({...inMemoryInput(),runSolver:async request=>({
    ...await fixtureSolver(request),exitCode:23,
  })}),error=>error.code==='native_solver'&&error.message.includes('exited 23'))
})

test('missing_run_state names the component, physical pin and IBIS signal for bound pins outside the channel',async()=>{
  const input=inMemoryInput()
  input.circuitJson.push({type:'source_port',source_port_id:'source_port_347',source_component_id:'u0',name:'N4',port_hints:['DDR_DQS0','N4']})
  const model=input.circuitJson.find(record=>record.type==='simulation_ibis_model'&&record.source_component_id==='u0')
  model.ibis_pin_name_to_source_port_id.N4='source_port_347'
  const ibisText=input.ibisSources['models/test.ibs'].toString('utf8').replace('4 VSS GND\r\n','4 VSS GND\r\nN4 DDR_DQS0 IN\r\n')
  input.ibisSources['models/test.ibs']=Buffer.from(ibisText)
  await assert.rejects(
    runPipeline({...input,runSolver:async()=>{throw new Error('solver must not run')}}),
    error=>error?.code==='missing_run_state'&&
      /^TX\.N4 \(IBIS DDR_DQS0\): explicit compatible input\/output state is required \(source_port_347\); set ibisPinStates \(e\.g\. \{ isOutput: false \}\)$/.test(error.message)
  )
})
