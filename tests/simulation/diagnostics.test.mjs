// Every code in src/simulation/diagnostics.ts raised with today's code AND message (module rule M3).
// MESSAGES are the pre-module implementation's messages, recorded on 2026-11-07 while the old flat src/
// still existed and this test compared old and new raisers directly.
import test from 'node:test'
import assert from 'node:assert/strict'
import {Diagnostic} from '../../src/kernel/index.js'
import {geometryFromCircuitJson} from '../../src/board/index.js'
import * as current from '../../src/simulation/index.js'
import {fixture} from './fixtures.mjs'

const impls={
  current:{...current,geometry:geometryFromCircuitJson},
}
const one=(cj,type,pred=()=>true)=>cj.find(e=>e.type===type&&pred(e))
const declare=(mutate=()=>{},m=undefined)=>impl=>{
  const {cj,m:base}=fixture()
  const modeling=m?m(base):base
  const out=mutate(cj)??cj
  return impl.generalDeclarations(out,impl.geometry(out,modeling),modeling)
}
const electrical=(mutate,m=base=>base)=>impl=>{
  const {cj,m:base}=fixture()
  mutate?.(cj)
  const modeling=m(base)
  const g=impl.geometry(cj,modeling)
  return impl.electricalSources(cj,modeling,impl.circuitNodes(cj,g,modeling))
}
const deck=(extraction,models=[{source:'.subckt BUFFER P R\nRTEST P R 1000\n.ends BUFFER\n',spicePinMapping:{P:'p0',R:'g0'},name:'test'}])=>impl=>{
  const {cj,m}=fixture()
  const g=impl.geometry(cj,m)
  const d=impl.generalDeclarations(cj,g,m)
  return impl.generalSimulationSpice(d.plans[0],g,m,extraction,models,d.nodes,impl.electricalSources(cj,m,d.nodes))
}
const identity=[[1,0],[0,1]]
const matrices=[{R:identity,L:identity,C:identity}]
const square=extra=>cj=>{
  cj.push({type:'simulation_voltage_source',simulation_voltage_source_id:'sq',is_dc_source:false,terminal1_source_port_id:'v0',terminal2_source_port_id:'g0',voltage:3.3,frequency:1e6,wave_shape:'square',...extra})
}


const MESSAGES={
 "simulation_reference": "simulation_reference: Duplicate simulation_voltage_probe identifier diff",
 "simulation_experiment": "simulation_experiment: A transient experiment with spiceEngine=pcb_spice is required",
 "simulation_capability": "simulation_capability: This PCB backend supports unswept transient experiments only",
 "simulation_timing": "simulation_timing: run time_per_step: finite positive milliseconds required",
 "simulation_scope": "simulation_scope: data: no models in its explicit subcircuit scope",
 "simulation_probe": "simulation_probe: data: at least one voltage probe required",
 "native_declaration": "native_declaration: bad ibisModel",
 "ibis_model": "ibis_model: At least one serialized native IBIS model required",
 "ibis_mapping": "ibis_mapping: TX: physical pin mapping points outside its chip",
 "ibis_state": "ibis_state: data: duplicate run state for p0",
 "channel_model": "channel_model: data DQSn: endpoint p3 requires exactly one modeled physical pin and an explicit run state",
 "stimulus_duplicate": "stimulus_duplicate: data: multiple stimuli drive the same physical output",
 "stimulus_state": "stimulus_state: stimulus1: stimulus requires an enabled IBIS output in this experiment",
 "stimulus_missing": "stimulus_missing: data: enabled output requires one explicit digital stimulus",
 "stimulus_pattern": "stimulus_pattern: A nonempty binary string or array of numeric 0/1 bits is required",
 "stimulus_coverage": "stimulus_coverage: stimulus0: nonrepeating bits do not cover the complete run",
 "probe_reference": "probe_reference: diff: unknown signal/reference source",
 "eye_timing": "eye_timing: diff: measurement gate must fit the recorded run and contain a complete two-UI window",
 "eye_reference": "eye_reference: diff: unknown or unsupported transient experiment",
 "channel_short": "channel_short: Extracted endpoints are shorted by another ideal source trace or reference",
 "electrical_input": "electrical_input: declared supply: explicit finite value required",
 "supply_reference": "supply_reference: Voltage sources require explicit positive and negative source port/net terminals",
 "supply_short": "supply_short: Explicit supply terminals resolve to the same node",
 "supply_missing": "supply_missing: Declare physical voltage sources or explicit source-port supplies; this backend never invents VDD",
 "source_edge": "source_edge: Square voltage sources require explicit positive rise/fall times",
 "source_capability": "source_capability: Voltage waveform sinewave is unsupported by this PCB backend",
 "passive_reference": "passive_reference: Selected passive component is missing or ambiguous",
 "passive_capability": "passive_capability: TX: expected two physical ports",
 "matrix_dimension": "matrix_dimension: Extracted channels must match every selected signal",
 "ibis_contract": "ibis_contract: Converter did not emit a SPICE component wrapper",
 "spice_options": "spice_options: Unsupported integration method",
 "probe_observation": "probe_observation: single: signal/reference is outside the declared electrical model scope"
}

test('simulation codes and messages equal the pre-module implementation', () => {
  for (const [code, run] of [

  ['simulation_reference',declare(cj=>{cj.push({...one(cj,'simulation_voltage_probe')})})],
  ['simulation_experiment',declare(cj=>{one(cj,'simulation_experiment').spice_engine='ngspice'})],
  ['simulation_capability',declare(cj=>{one(cj,'simulation_experiment').experiment_type='spice_dc_operating_point'})],
  ['simulation_timing',declare(cj=>{one(cj,'simulation_experiment').time_per_step=0})],
  ['simulation_scope',declare(cj=>{one(cj,'simulation_experiment').subcircuit_id='unrelated'})],
  ['simulation_probe',declare(cj=>cj.filter(e=>e.type!=='simulation_voltage_probe'))],
  ['native_declaration',declare(cj=>{cj.push({type:'source_invalid_component_property_error',property_name:'ibisModel',message:'bad ibisModel'})})],
  ['ibis_model',declare(cj=>cj.filter(e=>e.type!=='simulation_ibis_model'))],
  ['ibis_mapping',declare(cj=>{one(cj,'simulation_ibis_model').ibis_pin_name_to_source_port_id['9']='p2'})],
  ['ibis_state',declare(cj=>{cj.push({...one(cj,'simulation_ibis_pin_state')})})],
  ['channel_model',declare(cj=>cj.filter(e=>!(e.type==='simulation_ibis_pin_state'&&e.source_port_id==='p3')))],
  ['stimulus_duplicate',declare(cj=>{cj.push({...one(cj,'simulation_digital_stimulus')})})],
  ['stimulus_state',declare(cj=>{one(cj,'simulation_digital_stimulus',s=>s.source_port_id==='p1').source_port_id='p2'})],
  ['stimulus_missing',declare(cj=>cj.filter(e=>!(e.type==='simulation_digital_stimulus'&&e.source_port_id==='p1')))],
  ['stimulus_pattern',declare(cj=>{one(cj,'simulation_digital_stimulus').transmission_pattern.bits='012'})],
  ['stimulus_coverage',declare(cj=>{one(cj,'simulation_digital_stimulus').transmission_pattern={transmission_type:'bits',bits:'001',repeat:false}})],
  ['probe_reference',declare(cj=>{one(cj,'simulation_voltage_probe').signal_input_source_port_id='missing'})],
  ['eye_timing',declare(cj=>{one(cj,'simulation_eye_diagram').end_time_ms=.02})],
  ['eye_reference',declare(cj=>{cj.push({...one(cj,'simulation_eye_diagram'),simulation_eye_diagram_id:'ghost',simulation_experiment_id:'ghost'})})],
  ['channel_short',declare(cj=>{cj.push({type:'source_trace',source_trace_id:'short',connected_source_port_ids:['p0','p2']})})],
  ['electrical_input',electrical(undefined,m=>({...m,supplies:[{...m.supplies[0],voltageV:NaN}]}))],
  ['supply_reference',electrical(cj=>{cj.push({type:'simulation_voltage_source',simulation_voltage_source_id:'dc',is_dc_source:true,voltage:1,positive_source_port_id:'v0'})})],
  ['supply_short',electrical(undefined,m=>({...m,supplies:[{...m.supplies[0],positive:{sourcePortId:'g0'}}]}))],
  ['supply_missing',electrical(undefined,m=>({...m,supplies:[]}))],
  ['source_edge',electrical(square({}))],
  ['source_capability',electrical(square({wave_shape:'sinewave'}))],
  ['passive_reference',electrical(undefined,m=>({...m,passiveComponents:[{sourceComponentId:'missing'}]}))],
  ['passive_capability',electrical(undefined,m=>({...m,passiveComponents:[{sourceComponentId:'u0'}]}))],
  ['matrix_dimension',deck([{R:[[1]],L:[[1]],C:[[1]]}])],
  ['ibis_contract',deck(matrices,[{source:'* no wrapper\n',spicePinMapping:{},name:'bad'}])],
  ['spice_options',impl=>impl.simulationSpiceOptions({method:'euler'})],
  ['probe_observation',impl=>{
    const {cj,m}=fixture()
    cj.push({type:'source_port',source_port_id:'x0',source_component_id:'u0',name:'NC'})
    one(cj,'simulation_voltage_probe',p=>p.simulation_voltage_probe_id==='single').signal_input_source_port_id='x0'
    const g=impl.geometry(cj,m)
    const d=impl.generalDeclarations(cj,g,m)
    return impl.validateProbeScope(d.plans[0],g,[],d.nodes,impl.electricalSources(cj,m,d.nodes))
  }],
  ]) {
    assert.ok(Object.hasOwn(MESSAGES, code), code)
    assert.throws(() => run(impls.current), e => {
      assert.ok(e instanceof Diagnostic, code)
      assert.equal(e.domain, 'simulation')
      assert.deepEqual({ code: e.code, message: e.message }, { code, message: MESSAGES[code] })
      return true
    }, code)
  }
})

test('result_schema: a schema that drops probe ids fails the result Circuit JSON', () => {
  const {cj,m}=fixture()
  const g=geometryFromCircuitJson(cj,m)
  const {plans}=current.generalDeclarations(cj,g,m)
  const run={records:[{type:'simulation_transient_voltage_graph',simulation_experiment_id:'run'}]}
  assert.throws(()=>current.simulationResultCircuitJson(cj,plans,[run]),{code:'result_schema',message:'result_schema: Installed Circuit JSON schema discarded the result probe ID'})
  assert.equal(current.simulationResultCircuitJson(cj,plans,[]).length,cj.length)
})
