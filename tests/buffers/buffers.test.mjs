// Ported from tests/general.test.mjs 'pipeline verifies optional expected IBIS asset hashes before invoking any solver':
// admission is now its own pure call, so "before any solver" is "admitBuffers takes no solver at all".
import test from 'node:test'
import assert from 'node:assert/strict'
import {rootScope,sha256} from '../../src/kernel/index.js'
import {geometryFromCircuitJson} from '../../src/board/index.js'
import {generalDeclarations,modelRunDefinition} from '../../src/simulation/index.js'
import {assertConverter,admitBuffers,compileBuffers,ibisAssembly} from '../../src/buffers/index.js'
import {inMemoryInput} from '../simulation/fixtures.mjs'

const declared=input=>generalDeclarations(input.circuitJson,geometryFromCircuitJson(input.circuitJson,input.modeling),input.modeling)
const admit=(input,modeling=input.modeling,ibisSources=input.ibisSources)=>admitBuffers(declared(input).models,ibisSources,modeling,rootScope('buffers'))

test('pipeline verifies optional expected IBIS asset hashes before invoking any solver',()=>{
  const input=inMemoryInput()
  const path='models/test.ibs'
  const locked={...input.modeling,ibisModelAssetSha256:{[path]:sha256(input.ibisSources[path]).toUpperCase()}}
  assert.doesNotThrow(()=>admit(input,locked))
  assert.doesNotThrow(()=>admit(input))
  const ibisSources={[path]:Buffer.concat([input.ibisSources[path],Buffer.from('| changed valid model comment\r\n')])}
  assert.throws(()=>admit(input,locked,ibisSources),/vendor_hash.*bytes differ/)
  for(const ibisModelAssetSha256 of [{},{[path]:'bad-hash'},null,[]])
    assert.throws(()=>admit(input,{...input.modeling,ibisModelAssetSha256}),/vendor_hash.*(?:expected|must map)/)
  assert.throws(()=>admit(input,input.modeling,{}),{code:'ibis_asset_missing'})
  assert.throws(()=>admit(input,input.modeling,{[path]:'PK\x03\x04'}),{code:'ibis_asset'})
})

test('admission records exact source bytes and evidence; compilation pins each run to them',()=>{
  const input=inMemoryInput()
  const declarations=declared(input)
  const admitted=admitBuffers(declarations.models,input.ibisSources,input.modeling,rootScope('buffers'))
  assert.doesNotThrow(()=>assertConverter(),'converter_version')
  assert.deepEqual(admitted.artifacts.map(a=>a.path),['inputs/ibis/model-0.ibs','inputs/ibis/model-1.ibs','vendor-sources.json'])
  assert.ok(admitted.artifacts.every(a=>a.owner==='buffers'))
  const evidence=JSON.parse(admitted.artifacts.at(-1).body)
  assert.deepEqual(evidence.map(e=>e.sourceSha256),[sha256(input.ibisSources['models/test.ibs']),sha256(input.ibisSources['models/test.ibs'])])
  const compiled=compileBuffers(admitted.value,declarations.plans,modelRunDefinition)
  assert.equal(compiled.length,1)
  assert.equal(compiled[0].length,2)
  for(const model of compiled[0]) assert.deepEqual(model.input.definition.source,{file:model.sourceEvidence.ibsFile,sha256:model.sourceEvidence.sourceSha256})
  const assembly=ibisAssembly(compiled[0],rootScope('buffers').child('experiments','run'))
  assert.deepEqual(assembly.artifacts.map(a=>a.path),['experiments/run/native-ibis-assembly.json'])
  assert.deepEqual(assembly.value.map(a=>a.spiceSha256),compiled[0].map(m=>sha256(m.source)))
  assert.deepEqual(JSON.parse(assembly.artifacts[0].body),JSON.parse(JSON.stringify(assembly.value)))
})

test('missing_run_state names the component, physical pin and IBIS signal for bound pins outside the channel',()=>{
  const input=inMemoryInput()
  input.circuitJson.push({type:'source_port',source_port_id:'source_port_347',source_component_id:'u0',name:'N4',port_hints:['DDR_DQS0','N4']})
  const model=input.circuitJson.find(record=>record.type==='simulation_ibis_model'&&record.source_component_id==='u0')
  model.ibis_pin_name_to_source_port_id.N4='source_port_347'
  const ibisText=input.ibisSources['models/test.ibs'].toString('utf8').replace('4 VSS GND\r\n','4 VSS GND\r\nN4 DDR_DQS0 IN\r\n')
  input.ibisSources['models/test.ibs']=Buffer.from(ibisText)
  const declarations=declared(input)
  const admitted=admitBuffers(declarations.models,input.ibisSources,input.modeling,rootScope('buffers'))
  assert.throws(
    ()=>compileBuffers(admitted.value,declarations.plans,modelRunDefinition,input.circuitJson),
    error=>error?.code==='missing_run_state'&&
      /^TX\.N4 \(IBIS DDR_DQS0\): explicit compatible input\/output state is required \(source_port_347\); set ibisPinStates \(e\.g\. \{ isOutput: false \}\)$/.test(error.message)
  )
})
