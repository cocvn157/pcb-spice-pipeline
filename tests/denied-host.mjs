// Runs in a fresh process so the public import graph is not already cached.
import assert from 'node:assert/strict'
import {builtinModules,registerHooks} from 'node:module'
import {readFileSync} from 'node:fs'
import {fixtureSolver} from './fixtures/solver.mjs'
const input=JSON.parse(readFileSync(0,'utf8'))
const requests=[]
const progress=[]
const before=JSON.stringify(input)
const denied=()=>{
  throw Error('Implicit host action denied')
}
const builtin=new Set([...builtinModules,...builtinModules.map(name=>'node:'+name)])
registerHooks({resolve(specifier,context,next){
  if(builtin.has(specifier)||specifier==='react'||specifier.startsWith('@tscircuit/core')||specifier.startsWith('tsx')||/^https?:/.test(specifier)) throw Error('Forbidden import '+specifier+' from '+context.parentURL)
  return next(specifier,context)
}})
globalThis.fetch=denied
globalThis.console=new Proxy({},{get:()=>denied})
Object.defineProperty(globalThis,'process',{get:denied})
globalThis.Date=new Proxy(Date,{construct:denied,get:(target,key)=>key==='now'?denied:Reflect.get(target,key)})
Object.defineProperty(globalThis,'performance',{get:denied})
const {runPipeline,generateReport}=await import('../dist/index.js')
const result=await runPipeline({...input,runSolver:async request=>{
  requests.push(structuredClone(request))
  return fixtureSolver(request)
},onProgress:message=>progress.push(message)})
assert.deepEqual(requests.map(request=>request.solver),['fasthenry','fasthenry','fastercap','ngspice'])
assert.ok(progress.length>=2)
assert.equal(JSON.stringify(input),before)
assert.equal(result.matrices.length,1)
assert.deepEqual(result.matrices[0].units,{R:'ohm',L:'H',C:'F'})
assert.ok(Math.abs(result.matrices[0].C[0][0]-10e-12/3)<1e-24)
const experiment=result.experiments[0]
const rows=experiment.waveform.rows
assert.equal(experiment.solverInvocations,1)
assert.deepEqual([experiment.waveform.timeUnit,experiment.waveform.voltageUnit],['s','V'])
assert.equal(rows.length,101)
assert.deepEqual(result.simulationResultCircuitJson.slice(0,result.circuitJson.length),input.circuitJson)
for(const probe of experiment.probes) {
  const graph=result.simulationResultCircuitJson.find(record=>record.type==='simulation_transient_voltage_graph'&&record.simulation_voltage_probe_id===probe.simulationVoltageProbeId)
  assert.deepEqual(graph.timestamps_ms,rows.map(row=>row[0]*1000))
  assert.deepEqual(graph.voltage_levels,rows.map(row=>row[probe.column]))
}
assert.ok(experiment.eyes.every(eye=>eye.samples.length===eye.windows*eye.pointsPerWindow))
const report=generateReport(result)
assert.match(report['results.html'],/id="simulation-data"/)
assert.doesNotMatch(report['results.html'],/<script[^>]+src=|https?:\/\//)
assert.ok(Object.keys(report).some(path=>path.endsWith('waveforms.csv')))
assert.deepEqual(report,generateReport(result))
