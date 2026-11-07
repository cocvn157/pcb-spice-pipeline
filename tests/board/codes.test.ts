// One minimal trigger per board diagnostic code not already exercised by the ported suites.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { CircuitJson } from 'circuit-json'
import { geometryFromCircuitJson, measuredLaneSpacingMm, subcircuitTree, type Modeling } from '../../src/board'
import { groundPlaneFixture, routedGroundPlaneFixture } from '../fixtures/ground-plane'

const read = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'))
const straight = (): { circuit: CircuitJson; modeling: Modeling } => ({ circuit: read('straight.circuit.json'), modeling: read('straight.modeling.json') })
const trace = (circuit: CircuitJson, id: string) => {
  const t = circuit.find(e => e.type === 'pcb_trace' && e.pcb_trace_id === id)
  if (t?.type !== 'pcb_trace') throw Error('fixture')
  return t
}
const rejects = (f: () => unknown, code: string, message?: RegExp) => assert.throws(f, (e: { code?: string; message: string }) => {
  assert.equal(e.code, code); if (message) assert.match(e.message, message); return true
})

test('modeling and lane selection failures', () => {
  const { circuit, modeling } = straight()
  rejects(() => geometryFromCircuitJson({} as never, modeling), 'circuit_json', /Expected a Circuit JSON element array/)
  rejects(() => geometryFromCircuitJson(circuit, { ...modeling, extraction: { ...modeling.extraction, filaments: -1 } }), 'modeling_input', /extraction\.filaments must be a positive number/)
  rejects(() => geometryFromCircuitJson(circuit, { ...modeling, lanes: [{ ...modeling.lanes[0], from: { component: 'missing', port: '1' } }] }), 'pin_mapping', /missing: expected one source component, got 0/)
  rejects(() => geometryFromCircuitJson(circuit, { ...modeling, lanes: [{ ...modeling.lanes[0], sourceTraceId: 'nope' }] }), 'route_selection', /DQS: expected one source trace/)
  rejects(() => geometryFromCircuitJson(circuit, { ...modeling, profiles: { top: { ...modeling.profiles!.top, spacingMm: .01 } } }), 'conductor_overlap', /Stage 0: sig0\/sig1 overlap/)
})

test('route shape failures', () => {
  const mutate = (edit: (c: CircuitJson, m: Modeling) => void) => { const { circuit, modeling } = straight(); edit(circuit, modeling); return () => geometryFromCircuitJson(circuit, modeling) }
  rejects(mutate(c => { trace(c, 't0').route.splice(1) }), 'empty_route', /DQS: at least two routed vertices required/)
  rejects(mutate(c => { Object.assign(trace(c, 't0').route[1], { start_width: .1 }) }), 'varying_width', /Tapered routes/)
  rejects(mutate(c => { Object.assign(trace(c, 't0').route[0], { x: 1 }) }), 'endpoint_position', /DQS: routed endpoints do not match/)
  rejects(mutate(c => { trace(c, 't0').route.splice(1, 0, { route_type: 'wire', x: 5, y: -.375, width: .1, layer: 'bottom' }) }), 'layer_transition', /Layer change requires explicit via/)
  rejects(mutate((c, m) => {
    Object.assign(m, { viaPlatingMm: .025, viaEquivalentWidthMm: .15, omitThroughViaStubs: true })
    trace(c, 't1').route = [
      { route_type: 'wire', x: 0, y: .375, width: .1, layer: 'top', start_pcb_port_id: 'b1' }, { route_type: 'wire', x: 3, y: .375, width: .1, layer: 'top' },
      { route_type: 'via', x: 3, y: .375, from_layer: 'top', to_layer: 'bottom', hole_diameter: .2 }, { route_type: 'wire', x: 6, y: .375, width: .1, layer: 'bottom' },
      { route_type: 'via', x: 6, y: .375, from_layer: 'bottom', to_layer: 'top', hole_diameter: .2 }, { route_type: 'wire', x: 10, y: .375, width: .1, layer: 'top', end_pcb_port_id: 'b3' },
    ]
  }), 'route_topology', /identical ordered layer\/via stage topology/)
  rejects(() => measuredLaneSpacingMm([[{ x: 0, y: 0, layer: 'top', route_type: 'wire' }], []], 'top'), 'lane_spacing', /lanes 0 and 1 share no routed segments/)
})

test('subcircuit ownership cycles', () => {
  const tree = () => subcircuitTree([{ type: 'source_group', source_group_id: 'a', subcircuit_id: 'sa', parent_source_group_id: 'b' }, { type: 'source_group', source_group_id: 'b', parent_source_group_id: 'a' }])
  rejects(tree, 'simulation_scope', /Cyclic source-group ownership/)
})

test('routed-copper ground failures', () => {
  const flag = groundPlaneFixture(), net = flag.circuit.find(e => e.type === 'source_net' && e.source_net_id === 'ground')!
  if (net.type === 'source_net') net.is_ground = false
  rejects(() => geometryFromCircuitJson(flag.circuit, flag.modeling), 'ground_net', /exactly one ground net/)
  const bare = groundPlaneFixture()
  bare.circuit = bare.circuit.filter(e => e.type !== 'pcb_copper_pour')
  rejects(() => geometryFromCircuitJson(bare.circuit, bare.modeling), 'ground_geometry', /GND: no physical ground copper pours found/)
  const split = groundPlaneFixture(), pour = split.circuit.find(e => e.type === 'pcb_copper_pour')!
  if (pour.type !== 'pcb_copper_pour' || pour.shape !== 'brep') throw Error('fixture')
  const box = (x0: number, x1: number) => ({ outer_ring: { vertices: [{ x: x0, y: -2 }, { x: x1, y: -2 }, { x: x1, y: 2 }, { x: x0, y: 2 }] }, inner_rings: [] })
  split.circuit.push({ ...pour, pcb_copper_pour_id: 'right', brep_shape: box(5.5, 11) })
  pour.brep_shape = box(-1, 4.5)
  rejects(() => geometryFromCircuitJson(split.circuit, split.modeling), 'ground_connectivity', /one connected pour/)
  const lead = routedGroundPlaneFixture()
  const point = lead.lead.route[1]
  if (point.route_type !== 'wire') throw Error('fixture')
  point.width = -1
  rejects(() => geometryFromCircuitJson(lead.circuit, lead.modeling), 'route_geometry', /Positive finite wire widths are required/)
})

test('reduction, section count and routed primitive type are validated before geometry', () => {
  const { circuit, modeling } = straight()
  rejects(() => geometryFromCircuitJson(circuit, { ...modeling, reduction: 'mesh' as never }), 'reduction', /Select straightened-stages or routed-copper/)
  for (const sections of [0, 129, 2.5]) rejects(() => geometryFromCircuitJson(circuit, { ...modeling, sections }), 'sections', /sections must be an integer 1\.\.128/)
  const arc = straight()
  Object.assign(trace(arc.circuit, 't0').route[1], { route_type: 'arc' })
  rejects(() => geometryFromCircuitJson(arc.circuit, arc.modeling), 'route_type', /Only wire\/via routed primitives supported/)
})
