// Copy of tests/fixtures/general.mjs + in-memory.mjs with geometry from the new board module.
import {readFile} from 'node:fs/promises'
import {geometryFromCircuitJson} from '../../src/board/index.js'
const read=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'))
export const circuit=await read('../fixtures/straight.circuit.json')
export const physical=await read('../fixtures/straight.modeling.json')
export const fixture=()=>{
  const cj=structuredClone(circuit)
  const m={...structuredClone(physical),channelReference:{sourcePortId:'g0'},supplies:[{positive:{sourcePortId:'v0'},negative:{sourcePortId:'g0'},voltageV:3.3}]}
  cj.push(...['u0','u1'].map((id,i)=>({type:'source_component',source_component_id:id,name:i?'RX':'TX',source_group_id:'board-group'})),{type:'source_port',source_port_id:'g0',source_component_id:'u0',name:'GND'},{type:'source_port',source_port_id:'v0',source_component_id:'u0',name:'VDD'})
  cj.push({type:'source_group',source_group_id:'board-group',subcircuit_id:'board',is_subcircuit:true})
  for(const [index,ids] of [['p0','p1'],['p2','p3']].entries()) cj.push({type:'simulation_ibis_model',simulation_ibis_model_id:`model-${index}`,source_component_id:`u${index}`,ibis_model_asset:{project_relative_path:'models/test.ibs',url:'./models/test.ibs',mimetype:'text/plain'},ibis_component_name:'test',ibis_pin_name_to_source_port_id:Object.fromEntries(ids.map((id,i)=>[String(i+1),id])),model_value_corner:'typical',include_package_parasitics:false})
  cj.push({type:'simulation_experiment',simulation_experiment_id:'run',subcircuit_id:'board',name:'data',experiment_type:'spice_transient_analysis',spice_engine:'pcb_spice',end_time_ms:.01,start_time_ms:0,time_per_step:.000001})
  for(const [i,id] of ['p0','p1','p2','p3'].entries()) {
    const state={type:'simulation_ibis_pin_state',simulation_experiment_id:'run',source_port_id:id,is_output:i<2}
    if(state.is_output) state.is_output_enabled=true
    cj.push(state)
  }
  for(const [i,id] of ['p0','p1'].entries()) cj.push({type:'simulation_digital_stimulus',simulation_experiment_id:'run',source_port_id:id,name:`stimulus${i}`,bit_duration_ms:.001,start_time_ms:0,initial_state:0,inverted:Boolean(i),transmission_pattern:{transmission_type:'bits',bits:'001110100',repeat:true}})
  cj.push({type:'simulation_voltage_probe',simulation_voltage_probe_id:'diff',subcircuit_id:'board',name:'diff',signal_input_source_port_id:'p2',reference_input_source_port_id:'p3'},{type:'simulation_voltage_probe',simulation_voltage_probe_id:'single',subcircuit_id:'board',name:'single',signal_input_source_port_id:'p2'})
  for(const [i,probe] of ['diff','single'].entries()) cj.push({type:'simulation_eye_diagram',simulation_eye_diagram_id:`eye-${i}`,simulation_experiment_id:'run',simulation_voltage_probe_id:probe,name:probe,unit_interval_ms:.001,time_origin_ms:.00025,start_time_ms:0,end_time_ms:.01})
  return {cj,m,g:geometryFromCircuitJson(cj,m)}
}
export function inMemoryInput() {
  const {cj,m}=fixture()
  for(const component of cj.filter(record=>record.type==='source_component')) component.ftype='simple_chip'
  for(const state of cj.filter(record=>record.type==='simulation_ibis_pin_state')) {
    state.is_output=false
    delete state.is_output_enabled
  }
  for(const [pin,name] of [['rx-vdd','VDD'],['rx-gnd','GND']]) cj.push({type:'source_port',source_port_id:pin,source_component_id:'u1',name})
  cj.push({type:'source_trace',source_trace_id:'vdd',connected_source_port_ids:['v0','rx-vdd'],connected_source_net_ids:[]},
    {type:'source_trace',source_trace_id:'gnd',connected_source_port_ids:['g0','rx-gnd'],connected_source_net_ids:[]})
  const models=cj.filter(record=>record.type==='simulation_ibis_model')
  models[0].ibis_pin_name_to_source_port_id['3']='v0'
  models[0].ibis_pin_name_to_source_port_id['4']='g0'
  models[1].ibis_pin_name_to_source_port_id['3']='rx-vdd'
  models[1].ibis_pin_name_to_source_port_id['4']='rx-gnd'
  const circuitJson=cj.filter(record=>record.type!=='simulation_digital_stimulus')
  const bytes=Buffer.from('[IBIS Ver] 4.2\r\n[Component] test\r\n[Pin] signal_name model_name\r\n1 D1 IN\r\n2 D2 IN\r\n3 VDD POWER\r\n4 VSS GND\r\n[Model] IN\r\nModel_type Input\r\nC_comp 1p 1p 1p\r\n[Voltage Range] 3.3 3.3 3.3\r\n[Power Clamp]\r\n-10 -0.1 -0.1 -0.1\r\n10 0.1 0.1 0.1\r\n[Gnd Clamp]\r\n-10 -0.2 -0.2 -0.2\r\n10 0.2 0.2 0.2\r\n[End]\r\n')
  return {circuitJson,modeling:m,ibisSources:{'models/test.ibs':bytes}}
}

export {fixtureSolver} from '../fixtures/solver.mjs'
