import test from 'node:test'
import assert from 'node:assert/strict'
import { geometryFromCircuitJson, parseRecord, type CircuitJson } from '../../../src/board'
import { fastHenryDeck, fasterCapDeck } from '../../../src/extraction'
import { groundPlaneFixture, routedGroundPlaneFixture } from '../../fixtures/ground-plane'
import { modeling as nativeModeling } from '../../fixtures/native-channel'
import { viaInPad } from '../../fixtures/via-in-pad'

test('ground selection follows reference connectivity and is_ground, independent of net name or proximity', () => {
  const { circuit, modeling } = groundPlaneFixture()
  const net = circuit.find(e => e.type === 'source_net' && e.source_net_id === 'ground')!
  if (net.type !== 'source_net') throw Error('fixture')
  net.name = 'reference-copper'
  const pour = circuit.find(e => e.type === 'pcb_copper_pour')!
  if (pour.type !== 'pcb_copper_pour') throw Error('fixture')
  circuit.push({ ...pour, pcb_copper_pour_id: 'power-plane', source_net_id: 'power' })
  const g = geometryFromCircuitJson(circuit, modeling)
  const copper = g.cells[0].routedCopper!
  assert.equal(copper.sourceNetId, 'ground')
  assert.equal(copper.sourceNetName, 'reference-copper')
  assert.deepEqual(copper.pours.map(p => p.pcbCopperPourId), ['ground-plane'])
  assert.deepEqual(copper.referenceSourcePortIds, ['ground0', 'ground1'])
  assert.deepEqual(copper.pours[0].polygon[1], [[4, .25], [6, .25], [6, -.25], [4, -.25]])
  assert.ok(Math.abs(copper.pours[0].zMaxMm - copper.pours[0].zMinMm - .035) < 1e-12)
})

test('one ground split into same-named per-subcircuit net records is a single ground', () => {
  // Subcircuits scope net records, so a board-wide GND appears once per subcircuit.
  const { circuit, modeling } = groundPlaneFixture()
  const net = circuit.find(e => e.type === 'source_net' && e.source_net_id === 'ground')!
  if (net.type !== 'source_net') throw Error('fixture')
  circuit.push({ ...net, source_net_id: 'ground-other-subcircuit', subcircuit_id: 'other' },
    { type: 'source_trace', source_trace_id: 'tie', connected_source_port_ids: ['ground1'], connected_source_net_ids: ['ground-other-subcircuit'] })
  const copper = geometryFromCircuitJson(circuit, modeling).cells[0].routedCopper!
  assert.equal(copper.sourceNetId, 'ground', 'named after the reference pin\'s own ground record')
  assert.deepEqual(copper.pours.map(p => p.pcbCopperPourId), ['ground-plane'])
})

test('signal route endpoints must reach the physical source and receiver pad layers', () => {
  for (const id of ['b0', 'b2']) {
    const { circuit, modeling } = groundPlaneFixture()
    const port = circuit.find(e => e.type === 'pcb_port' && e.pcb_port_id === id)!
    if (port.type !== 'pcb_port') throw Error('fixture')
    port.layers = ['bottom']
    assert.throws(() => geometryFromCircuitJson(circuit, modeling), /endpoint_layer/)
  }
})

test('missing/ambiguous ground, missing geometry and disconnected references never fall back to a strip', () => {
  for (const kind of ['flag', 'ambiguous', 'pour', 'return'] as const) {
    const { circuit, modeling } = groundPlaneFixture()
    if (kind === 'flag') {
      const net = circuit.find(e=>e.type==='source_net'&&e.source_net_id==='ground')!
      if(net.type==='source_net') net.is_ground=false
    }
    if (kind === 'ambiguous') circuit.push({ type:'source_net',source_net_id:'other',name:'OTHER',is_ground:true,member_source_group_ids:[] }, { type:'source_trace',source_trace_id:'short',connected_source_port_ids:['ground0'],connected_source_net_ids:['other'] })
    if (kind === 'pour') circuit.splice(circuit.findIndex(e=>e.type==='pcb_copper_pour'),1)
    if (kind === 'return') {
      const trace=circuit.find(e=>e.type==='source_trace'&&e.source_trace_id==='ground-trace1')!
      if(trace.type==='source_trace') trace.connected_source_net_ids=[]
    }
    assert.throws(()=>geometryFromCircuitJson(circuit,modeling),/ground_(net|geometry|reference)/)
  }
})

test('receiver ground is inferred from IBIS references and conflicting or missing bindings fail', () => {
  const { circuit, modeling } = groundPlaneFixture()
  delete modeling.groundReturn
  assert.deepEqual(geometryFromCircuitJson(circuit, modeling).cells[0].routedCopper!.referenceSourcePortIds, ['ground0', 'ground1'])
  const model = circuit.find(e => e.type === 'simulation_ibis_model')!
  if (model.type !== 'simulation_ibis_model') throw Error('fixture')
  model.ibis_pin_name_to_reference_source_port_ids!['4'].ground_clamp_reference_source_port_id = 'ground0'
  assert.throws(() => geometryFromCircuitJson(circuit, modeling), /ground_reference/)
  delete model.ibis_pin_name_to_reference_source_port_ids
  assert.throws(() => geometryFromCircuitJson(circuit, modeling), /ground_reference/)
})

test('physical ground contacts require copper pads and cannot be placed in a cutout', () => {
  for (const kind of ['missing-pad', 'cutout'] as const) {
    const { circuit, modeling } = groundPlaneFixture()
    if (kind === 'missing-pad') circuit.splice(circuit.findIndex(e => e.type === 'pcb_smtpad'), 1)
    else {
      const port = circuit.find(e => e.type === 'pcb_port' && e.source_port_id === 'ground1')!
      if (port.type !== 'pcb_port') throw Error('fixture')
      port.x = 5
      port.y = 0
    }
    assert.throws(() => geometryFromCircuitJson(circuit, modeling), /ground_connection/)
  }
})

test('ground routes preserve the physical pad layer and reject misplaced vias or a via endpoint', () => {
  const valid = routedGroundPlaneFixture()
  const connection = geometryFromCircuitJson(valid.circuit, valid.modeling).cells[0].routedCopper!.connections[0]
  assert.deepEqual(connection.terminals, [[0, -1, .2175], [1, -1, -.0175]])
  assert.equal(connection.contactRadiusMm, .1)
  for (const kind of ['wrong-layer', 'misplaced-via', 'via-endpoint'] as const) {
    const { circuit, modeling, lead } = routedGroundPlaneFixture()
    if (kind === 'wrong-layer') for (const point of lead.route) {
      if (point.route_type === 'wire') point.layer = 'bottom'
    } else {
      lead.route.push({ route_type: 'via', x: kind === 'misplaced-via' ? 2 : 1, y: -1, from_layer: 'top', to_layer: 'bottom', hole_diameter: .1 })
      if (kind === 'misplaced-via') lead.route.push({ route_type: 'wire', x: 2, y: -1, layer: 'bottom', width: .1 })
    }
    assert.throws(() => geometryFromCircuitJson(circuit, modeling), kind === 'misplaced-via' ? /via_geometry/ : /ground_connection/)
  }
})

test('bent routes and ground polygon coordinates remain physical and input records stay unchanged', () => {
  const { circuit, modeling } = groundPlaneFixture()
  const trace = circuit.find(e => e.type === 'pcb_trace' && e.pcb_trace_id === 't0')!
  if (trace.type !== 'pcb_trace') throw Error('fixture')
  trace.route.splice(1, 0, { route_type: 'wire', x: 4, y: -1.375, width: .1, layer: 'top' })
  const before = structuredClone(circuit)
  const g = geometryFromCircuitJson(circuit, modeling)
  const copper = g.cells[0].routedCopper!
  assert.deepEqual(circuit, before)
  assert.deepEqual(copper.signals[0].segments.map(s => [s.a, s.b]), [
    [[0, -.375, .2175], [4, -1.375, .2175]], [[4, -1.375, .2175], [10, -.375, .2175]],
  ])
  assert.deepEqual(copper.pours[0].polygon[0], [[-1, -2], [11, -2], [11, 2], [-1, 2]])
  assert.match(fastHenryDeck(g.cells[0], modeling.extraction), /x=0\.004 y=-0\.001375 z=0\.0002175/)
})

// Native via-in-pad reference contacts (was via-in-pad.test.ts).
test('native via-in-pad references reach the inner ground plane', async () => {
  const circuit = await viaInPad()
  assert.deepEqual(circuit.filter(e => e.type.endsWith('_error')), [])
  for (const record of circuit.filter(e => ['pcb_smtpad', 'pcb_via', 'pcb_copper_pour'].includes(e.type))) parseRecord(record)
  const cell = geometryFromCircuitJson(circuit, nativeModeling).cells[0]
  const copper = cell.routedCopper!
  assert.match(fastHenryDeck(cell, nativeModeling.extraction), /\.external/)
  assert.ok(fasterCapDeck(cell, nativeModeling.extraction)['return.txt'].includes('return'))
  assert.equal(copper.connections.length, 2)
  for (const path of copper.connections) {
    assert.equal(path.segments.length, 1)
    assert.notEqual(path.terminals[0][2], path.terminals[1][2])
    assert.equal(path.contactRadiusMm, .15)
  }
})

test('an offset barrel fully within the pad produces a physical pad connection', async () => {
  const circuit = await viaInPad({ offset: .04 })
  const connections = geometryFromCircuitJson(circuit, nativeModeling).cells[0].routedCopper!.connections
  for (const path of connections) {
    assert.equal(path.segments.length, 2)
    assert.ok(Math.abs(path.segments[0].b[0] - path.segments[0].a[0] - .04) < 1e-9)
  }
})

test('direct contacts reject disconnected, wrong-net, out-of-span, missing and ambiguous vias', async () => {
  for (const options of [
    { offset: .4 }, { viaNet: 'other' as const }, { viaEnd: 'inner1' as const, planeLayer: 'inner2' as const },
    { planeMiss: true }, { planeEdge: -3.25 }, { duplicate: true },
  ]) {
    const circuit = await viaInPad(options)
    assert.throws(() => geometryFromCircuitJson(circuit, nativeModeling), /ground_(connection|geometry)/, JSON.stringify(options))
  }
})

test('direct contacts validate barrel plating and omitted stubs', async () => {
  const circuit = await viaInPad()
  assert.throws(() => geometryFromCircuitJson(circuit, { ...nativeModeling, viaPlatingMm: .08 }), /via_geometry/)
  assert.throws(() => geometryFromCircuitJson(circuit, { ...nativeModeling, omitThroughViaStubs: false }), /via_stub/)
})

// Explicitly conflicting metadata is difficult to express as valid native TSX.
test('a native via with conflicting electrical metadata is not accepted', async () => {
  const circuit = await viaInPad()
  const via = circuit.find(e => e.type === 'pcb_via')!
  const signal = circuit.find(e => e.type === 'source_net' && e.name === 'DQ')!
  if (via.type !== 'pcb_via' || signal.type !== 'source_net') throw Error('fixture')
  via.source_net_id = signal.source_net_id
  parseRecord(via)
  assert.throws(() => geometryFromCircuitJson(circuit, nativeModeling), /ground_connection/)
})

test('a via with conflicting declared span cannot reach the pour', async () => {
  const circuit = await viaInPad()
  const via = circuit.find(e => e.type === 'pcb_via')!
  if (via.type !== 'pcb_via') throw Error('fixture')
  via.to_layer = 'inner2'
  parseRecord(via)
  assert.throws(() => geometryFromCircuitJson(circuit, nativeModeling), /ground_connection/)
})

test('a via center inside the pour is insufficient when the barrel crosses its edge', async () => {
  const circuit = await viaInPad({ planeEdge: -3.25 })
  const pour = circuit.find(e => e.type === 'pcb_copper_pour')!
  if (pour.type !== 'pcb_copper_pour' || pour.shape !== 'brep') throw Error('fixture')
  assert.ok(Math.abs(Math.min(...pour.brep_shape.outer_ring.vertices.map(p => p.x)) + 3.05) < 1e-9)
  assert.throws(() => geometryFromCircuitJson(circuit, nativeModeling), /ground_connection/)
})

test('a board-level via in the pad of a part inside a nested subcircuit is a direct contact', async () => {
  // Move both parts' pads into a child subcircuit of the board, as boards built
  // from subcircuits save them; the vias stay board-level.
  /** A via-in-pad board with either the pads or the vias moved into a child subcircuit. */
  const nest = async (scope: 'pads' | 'vias'): Promise<CircuitJson> => {
    const circuit = await viaInPad()
    const board = circuit.find(e => e.type === 'source_group' && e.is_subcircuit && !e.parent_source_group_id)!
    if (board.type !== 'source_group') throw Error('fixture')
    circuit.push({ type: 'source_group', source_group_id: 'child', name: 'CHILD', is_subcircuit: true, subcircuit_id: 'child_scope', parent_source_group_id: board.source_group_id })
    for (const e of circuit) if ((scope === 'pads' ? e.type === 'pcb_port' : e.type === 'pcb_via') && 'subcircuit_id' in e) e.subcircuit_id = 'child_scope'
    return circuit
  }
  const connections = geometryFromCircuitJson(await nest('pads'), nativeModeling).cells[0].routedCopper!.connections
  for (const path of connections) assert.equal(path.contactRadiusMm, .15)
  // A via owned by a nested subcircuit does not belong to a pad outside it.
  const nestedVias = await nest('vias')
  assert.throws(() => geometryFromCircuitJson(nestedVias, nativeModeling), /ground_connection/)
})
