// Moved from tests/pipeline-rerun.test.mjs; imports repointed to the new modules. Assertions unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import {runPipeline} from '../../src/index.js'
import {inMemoryInput,fixtureSolver} from '../fixtures/in-memory.mjs'

test('rerunning results replaces old graphs and preserves the physical input',async()=>{
  const input=inMemoryInput(),first=await runPipeline({...input,runSolver:fixtureSolver})
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
