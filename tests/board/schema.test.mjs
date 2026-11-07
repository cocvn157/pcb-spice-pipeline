import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {validateCircuitRecords,admitBoard} from '../../src/board/index.js'

// Board admission is the registered validation the pipeline runs before output or solvers.
test('malformed physical record fails registered validation before output or solvers',async()=>{
  const circuitJson=[{type:'pcb_plated_hole',pcb_plated_hole_id:'bad-hole'}]
  await assert.rejects(async()=>admitBoard(circuitJson),
    error=>error.code==='circuit_schema'&&/^circuit_schema: pcb_plated_hole bad-hole: /.test(error.message)&&error.message.length<300)
  assert.throws(()=>admitBoard({}),{code:'circuit_schema',message:'circuit_schema: Expected a Circuit JSON record array'})
})

test('registered valid records are checked without rewriting source values',()=>{
  const records=[{type:'source_component',source_component_id:'chip',ftype:'simple_chip',name:'CHIP'},{type:'simulation_voltage_probe',simulation_voltage_probe_id:'probe',signal_input_source_port_id:'port'}]
  const before=structuredClone(records)
  validateCircuitRecords(records)
  assert.deepEqual(records,before)
  assert.throws(()=>validateCircuitRecords([{type:'unknown_record',unknown_record_id:'bad'}]),/unknown_record bad: no registered record schema/)
})

test('newer circuit-json records validate without rewriting values or accepting invalid fields',()=>{
  const quote={type:'pcb_quote_estimate',pcb_quote_estimate_id:'quote',pcb_board_id:'board',supplier_name:'test supplier',currency:'USD',quantity:1,estimated_at:'2026-11-02T00:00:00Z',is_manufacturing_cost_complete:false,is_landed_cost_complete:false}
  const records=[quote]
  const before=structuredClone(records)
  validateCircuitRecords(records)
  assert.deepEqual(records,before)
  assert.throws(()=>validateCircuitRecords([{...quote,quantity:'invalid'}]),/circuit_schema: pcb_quote_estimate quote: .*quantity/)
})

test('saved board schema aliases validate without rewriting geometry or accepting malformed holes',async()=>{
  const records=JSON.parse(await readFile(new URL('../fixtures/am3352.circuit.json',import.meta.url),'utf8'))
  const original=JSON.stringify(records)
  validateCircuitRecords(records)
  assert.equal(JSON.stringify(records),original)
  const hole=structuredClone(records.find(record=>record.type==='pcb_plated_hole'&&record.shape==='circular_hole_with_rect_pad'))
  hole.hole_diameter='invalid'
  assert.throws(()=>validateCircuitRecords([hole]),/circuit_schema.*pcb_plated_hole/)
})

test('saved core group and board-text forms validate in both legacy and circuit-json shapes without rewriting',()=>{
  const group={type:'pcb_group',pcb_group_id:'group',source_group_id:'source_group',is_subcircuit:true,subcircuit_id:'sub',name:'Processor',
    center:{x:0,y:0},width:1,height:1,pcb_component_ids:[]}
  const text={type:'pcb_silkscreen_text',pcb_silkscreen_text_id:'text',anchor_alignment:'center',anchor_position:{x:0,y:0},
    font:'tscircuit2024',font_size:.4,layer:'top',text:'R1',ccw_rotation:0}
  const records=[
    {...group,anchor_alignment:null,display_offset_x:0,display_offset_y:-1.5},
    {...group,pcb_group_id:'current',anchor_alignment:'center',display_offset_x:'0mm',display_offset_y:'-1.5mm'},
    {...text,pcb_component_id:null},
    {...text,pcb_silkscreen_text_id:'omitted'},
  ]
  const before=structuredClone(records)
  validateCircuitRecords(records)
  assert.deepEqual(records,before)
  assert.throws(()=>validateCircuitRecords([{...group,anchor_alignment:'sideways'}]),/circuit_schema: pcb_group group: .*anchor_alignment/)
  assert.throws(()=>validateCircuitRecords([{...text,pcb_component_id:7}]),/circuit_schema: pcb_silkscreen_text text: .*pcb_component_id/)
})
