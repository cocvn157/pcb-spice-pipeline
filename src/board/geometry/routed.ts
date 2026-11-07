// Routed-copper geometry: connectivity, pour polygons, signal and reference-lead paths, in mm (was copper.ts minus meshing/decks).
import type { CircuitJson } from '../schema.js'
import { fail } from '../diagnostics.js'
import { connectedSourceIds } from '../connectivity.js'
import { subcircuitTree } from '../subcircuit.js'
import { selectPort, resolveRouteVias } from './ports.js'
import { ringArea as area, polygonContains as contains } from './polygon.js'
import type { CopperPoint as Point, CopperXYZ as XYZ, CopperPolygon as Polygon, CopperSegment as Segment, CopperPath as Path,
  Geometry, LaneMapping, ResolvedModeling, RoutedCopper } from './types.js'

const finite = (value: number) => Number.isFinite(value)
const distance = (a: XYZ, b: XYZ) => Math.hypot(...a.map((v, i) => v - b[i]))
const layer = (m: ResolvedModeling, name: string) => {
  const found = m.stackup.find(l => l.name === name)
  if (!found) fail('stackup', `No copper z range for ${name}`)
  return found
}
const z = (m: ResolvedModeling, name: string) => { const l = layer(m, name); return (l.zMinMm + l.zMaxMm) / 2 }

function routePath(route: LaneMapping['originalRoute'], m: ResolvedModeling): Path {
  if (!Array.isArray(route) || route.length < 2 || route[0].route_type !== 'wire') fail('route_geometry', 'Copper routes must start with a wire at a physical port')
  for (const point of route) {
    if (!['wire', 'via'].includes(point.route_type) || ![point.x, point.y].every(finite)) fail('route_geometry', 'Only finite wire/via coordinates are supported')
    if (point.route_type === 'wire') {
      if (!finite(point.width) || point.width <= 0) fail('route_geometry', 'Positive finite wire widths are required')
      if (point.start_width !== undefined || point.end_width !== undefined || point.width_interpolation_mode !== undefined) fail('varying_width', 'Tapered copper routes require an explicit supported reduction')
      layer(m, point.layer)
    }
  }
  const segments: Segment[] = []
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i]
    if (b.route_type === 'via') {
      if (a.route_type !== 'wire' || Math.hypot(b.x - a.x, b.y - a.y) > 1e-5 || a.layer !== b.from_layer || b.from_layer === b.to_layer) fail('via_geometry', 'Via must follow a co-located wire and continue its layer')
      const hole = b.hole_diameter, plating = m.viaPlatingMm!, width = m.viaEquivalentWidthMm!
      if (![hole, plating, width].every(value => typeof value === 'number' && finite(value) && value > 0)) fail('via_geometry', 'Positive finite via hole, plating and equivalent width required')
      if (!m.omitThroughViaStubs) fail('via_stub', 'Select omitThroughViaStubs for routed vias')
      segments.push({ a: [b.x, b.y, z(m, b.from_layer)], b: [b.x, b.y, z(m, b.to_layer)], widthMm: width,
        thicknessMm: Math.PI * ((hole! / 2 + plating) ** 2 - (hole! / 2) ** 2) / width })
    } else {
      const name = a.route_type === 'via' ? a.to_layer : a.layer, l = layer(m, name)
      if (b.layer !== name || !Number.isFinite(b.width) || b.width <= 0) fail('route_geometry', 'Continuous layer and positive width required')
      if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-10) segments.push({ a: [a.x, a.y, z(m, name)], b: [b.x, b.y, z(m, name)], widthMm: b.width, thicknessMm: l.zMaxMm - l.zMinMm, conductivitySm: l.conductivitySm })
    }
  }
  if (!segments.length || segments.some(s => ![...s.a, ...s.b, s.widthMm, s.thicknessMm].every(finite))) fail('route_geometry', 'Nonempty finite copper path required')
  for (let i = 1; i < segments.length; i++) if (distance(segments[i - 1].b, segments[i].a) > 1e-5) fail('route_geometry', 'Disconnected copper route')
  return { segments, terminals: [segments[0].a, segments.at(-1)!.b] }
}

type Via = Extract<CircuitJson[number], { type: 'pcb_via' }>

// A full barrel disk inside the pour avoids claiming a connection across a
// cutout or an edge that only intersects the drilled void.
function barrelInside(p: Point, radius: number, polygon: Polygon): boolean {
  if (!contains(p, polygon)) return false
  return polygon.every(ring => ring.every((a, i) => {
    const b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1]
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) > radius
  }))
}

function viaSpans(via: Via, from: string, to: string, m: ResolvedModeling): boolean {
  const indices = via.layers.map(name => m.stackup.findIndex(l => l.name === name))
  const start = m.stackup.findIndex(l => l.name === from), end = m.stackup.findIndex(l => l.name === to)
  if (indices.length < 2 || indices.some(i => i < 0) || start < 0 || end < 0 || start === end) return false
  const lo = Math.min(...indices), hi = Math.max(...indices)
  if (via.from_layer !== undefined || via.to_layer !== undefined) {
    const a = m.stackup.findIndex(l => l.name === via.from_layer), b = m.stackup.findIndex(l => l.name === via.to_layer)
    if (Math.min(a, b) !== lo || Math.max(a, b) !== hi) return false
  }
  return start >= lo && start <= hi && end >= lo && end <= hi
}

function validateReferenceVia(via: Via, m: ResolvedModeling, portId: string): number {
  const plating = m.viaPlatingMm!
  if (![via.x, via.y, via.outer_diameter, via.hole_diameter, plating].every(finite) || via.hole_diameter <= 0 || plating <= 0 || via.outer_diameter <= via.hole_diameter || via.hole_diameter + 2 * plating > via.outer_diameter + 1e-10)
    fail('via_geometry', `${portId}: reference via needs a valid plated barrel and copper diameter`)
  return via.hole_diameter / 2 + plating
}

/** Physical reference leads terminate on the selected pour, including their actual via. */
function groundConnection(circuit: CircuitJson, m: ResolvedModeling, portId: string, netIds: Set<string>, pours: RoutedCopper['pours']): Path {
  const ports = circuit.filter(e => e.type === 'pcb_port').filter(e => e.source_port_id === portId)
  if (ports.length !== 1 || ports[0].layers.length !== 1) fail('ground_connection', `${portId}: one PCB reference port/layer required`)
  const port = ports[0], start: XYZ = [port.x, port.y, z(m, port.layers[0])]
  if (![port.x, port.y].every(finite)) fail('ground_connection', `${portId}: finite physical reference coordinates required`)
  if (pours.some(p => p.layer === port.layers[0] && contains([port.x, port.y], p.polygon))) {
    const pads=circuit.filter(e=>e.type==='pcb_smtpad').filter(e=>e.pcb_port_id===port.pcb_port_id)
    if(pads.length!==1) fail('ground_connection',`${portId}: reference contact needs one physical copper pad`)
    const pad=pads[0], radius=pad.shape==='circle'?pad.radius:Math.min(Number(Reflect.get(pad,'width')),Number(Reflect.get(pad,'height')))/2
    if(!Number.isFinite(radius)||radius<=0) fail('ground_connection',`${portId}: reference pad requires a finite contact area`)
    return { segments: [], terminals: [start, start], contactRadiusMm:radius }
  }
  // A directly connected native via may be associated through its source trace,
  // not source_net_id. Require both that association and physical pad contact.
  const pads = circuit.filter(e => e.type === 'pcb_smtpad').filter(e => e.pcb_port_id === port.pcb_port_id && e.layer === port.layers[0])
  const connected = connectedSourceIds(circuit, portId), subcircuits = subcircuitTree(circuit)
  const directVias = circuit.filter(e => e.type === 'pcb_via').filter(via => {
    // Board-level vias commonly sit in pads of parts inside a nested subcircuit.
    if (!subcircuits.within(port.subcircuit_id, via.subcircuit_id) || (via.source_net_id && !netIds.has(via.source_net_id))) return false
    const trace = circuit.find(e => e.type === 'source_trace' && e.source_trace_id === via.source_trace_id)
    const traceMatches = trace && trace.type === 'source_trace' && [...trace.connected_source_port_ids, ...(trace.connected_source_net_ids ?? [])].some(id => connected.has(id))
    if (via.source_trace_id && !traceMatches) return false
    return !!(via.source_net_id && netIds.has(via.source_net_id)) || !!traceMatches
  }).filter(via => pads.some(pad => {
    if (pad.shape !== 'circle' && pad.shape !== 'rect') return false
    const radius = pad.shape === 'circle' ? pad.radius : Math.min(pad.width, pad.height) / 2
    return Number.isFinite(radius) && radius > 0 && Math.hypot(pad.x - port.x, pad.y - port.y) < 1e-5 &&
      Number.isFinite(via.outer_diameter) && via.outer_diameter > 0 && Math.hypot(via.x - pad.x, via.y - pad.y) + via.outer_diameter / 2 <= radius + 1e-10
  }))
  if (directVias.length) {
    if (pads.length !== 1 || directVias.length !== 1) fail('ground_connection', `${portId}: ambiguous reference pad/via contact`)
    const via = directVias[0], barrelRadius = validateReferenceVia(via, m, portId)
    const targets = pours.filter(p => viaSpans(via, port.layers[0], p.layer, m) && barrelInside([via.x, via.y], barrelRadius, p.polygon))
    if (targets.length !== 1) fail('ground_connection', `${portId}: reference via must connect unambiguously to actual ground copper`)
    const pad = pads[0]
    if (pad.shape !== 'circle' && pad.shape !== 'rect') fail('ground_connection', `${portId}: unsupported reference pad`)
    const padRadius = pad.shape === 'circle' ? pad.radius : Math.min(pad.width, pad.height) / 2
    const width = Math.min(m.viaEquivalentWidthMm!, 2 * (padRadius - Math.hypot(via.x - pad.x, via.y - pad.y)))
    const route: LaneMapping['originalRoute'] = [
      { route_type: 'wire', x: port.x, y: port.y, layer: port.layers[0], width },
      { route_type: 'wire', x: via.x, y: via.y, layer: port.layers[0], width },
      { route_type: 'via', x: via.x, y: via.y, from_layer: port.layers[0], to_layer: targets[0].layer as typeof port.layers[0], hole_diameter: via.hole_diameter },
    ]
    return { ...routePath(route, m), contactRadiusMm: via.outer_diameter / 2 }
  }
  const traceIds = new Set(circuit.filter(e => e.type === 'source_trace').filter(e => e.connected_source_port_ids.includes(portId) && e.connected_source_net_ids?.some(id => netIds.has(id))).map(e => e.type === 'source_trace' ? e.source_trace_id : ''))
  const traces = circuit.filter(e => e.type === 'pcb_trace').filter(e => traceIds.has(e.source_trace_id ?? ''))
  if (traces.length !== 1) fail('ground_connection', `${portId}: require one routed ground lead to a reference via/pour`)
  let route = resolveRouteVias(circuit, traces[0])
  if (!Array.isArray(route) || route.length < 2) fail('ground_connection', `${portId}: reference lead requires a complete physical route`)
  if (Math.hypot(route[0].x - port.x, route[0].y - port.y) > 1e-5) route = [...route].reverse().map(p => p.route_type === 'via' ? { ...p, from_layer: p.to_layer, to_layer: p.from_layer } : p)
  if (Math.hypot(route[0].x - port.x, route[0].y - port.y) > 1e-5) fail('ground_connection', `${portId}: reference route does not start at its physical pad`)
  const first = route[0]
  if (first.route_type !== 'wire' || first.layer !== port.layers[0]) fail('ground_connection', `${portId}: reference route must start on its physical pad layer`)
  for (const key of ['start_pcb_port_id', 'end_pcb_port_id'] as const) if (first[key] && first[key] !== port.pcb_port_id) fail('ground_connection', `${portId}: reference route endpoint metadata disagrees with its physical pad`)
  const end = route.at(-1)!
  let contactRadiusMm: number
  if (end.route_type !== 'wire') fail('ground_connection', `${portId}: ground lead must end on a wire layer`)
  if (!pours.some(p => p.layer === end.layer && contains([end.x, end.y], p.polygon))) {
    const vias = circuit.filter(e => e.type === 'pcb_via').filter(e => e.source_net_id && netIds.has(e.source_net_id) && e.layers.includes(end.layer) && Math.hypot(e.x - end.x, e.y - end.y) < 1e-5)
    const targets = vias.flatMap(via => pours.filter(p => viaSpans(via, end.layer, p.layer, m) && contains([via.x, via.y], p.polygon)).map(p => ({ via, pour: p })))
    if (targets.length !== 1) fail('ground_connection', `${portId}: reference via must connect unambiguously to actual ground copper`)
    const { via, pour } = targets[0]
    const barrelRadius = validateReferenceVia(via, m, portId)
    if (!barrelInside([via.x, via.y], barrelRadius, pour.polygon)) fail('ground_connection', `${portId}: reference barrel misses ground copper`)
    contactRadiusMm = via.outer_diameter/2
    if (!m.omitThroughViaStubs) fail('via_stub', 'Select omitThroughViaStubs for the reference lead')
    route = [...route, { route_type: 'via', x: end.x, y: end.y, from_layer: end.layer, to_layer: pour.layer as typeof end.layer, hole_diameter: via.hole_diameter }]
  } else contactRadiusMm = end.width/2
  const path = routePath(route, m)
  if (!pours.some(p => Math.abs((p.zMinMm + p.zMaxMm) / 2 - path.terminals[1][2]) < 1e-8 && contains(path.terminals[1].slice(0, 2) as Point, p.polygon))) fail('ground_connection', `${portId}: reference lead misses ground copper`)
  return {...path,contactRadiusMm}
}

export function routedCopperGeometry(circuit: CircuitJson, m: ResolvedModeling, mappings: LaneMapping[]): Geometry {
  const reference = selectPort(circuit, m.channelReference).source_port_id, connected = connectedSourceIds(circuit, reference)
  const groundNets = circuit.filter(e => e.type === 'source_net').filter(e => e.is_ground && connected.has(e.source_net_id))
  // Net records are scoped per subcircuit: one physical ground spanning several
  // subcircuits is several same-named records joined by traces. Name it after
  // the record the reference pin connects to; distinct ground names stay ambiguous.
  const direct = new Set(circuit.filter(e => e.type === 'source_trace').filter(e => e.connected_source_port_ids.includes(reference)).flatMap(e => e.type === 'source_trace' ? e.connected_source_net_ids ?? [] : []))
  const own = groundNets.filter(e => direct.has(e.source_net_id))
  const net = groundNets.length === 1 ? groundNets[0] : own.length === 1 ? own[0] : undefined
  if (!net || groundNets.some(e => e.name !== net.name))
    fail('ground_net', 'The channel reference must connect to exactly one ground net (same-named source_net records marked is_ground across subcircuits)')
  const netIds = new Set(circuit.filter(e => e.type === 'source_net').filter(e => connected.has(e.source_net_id)).map(e => e.type === 'source_net' ? e.source_net_id : ''))
  const pours: RoutedCopper['pours'] = circuit.filter(e => e.type === 'pcb_copper_pour').filter(e => netIds.has(e.source_net_id ?? '')).map(pour => {
    if (pour.shape !== 'brep') fail('ground_geometry', `${pour.pcb_copper_pour_id}: polygon BREP copper required`)
    const rings = [pour.brep_shape.outer_ring, ...pour.brep_shape.inner_rings]
    const polygon = rings.map((ring, i) => {
      const points: Point[] = ring.vertices.map(p => [p.x, p.y])
      if (points.length < 3 || points.some(p => !p.every(finite)) || Math.abs(area(points)) < 1e-12) fail('ground_geometry', 'Ground copper requires finite, nonzero polygon rings')
      if (ring.vertices.some(p => 'bulge' in p && p.bulge)) fail('ground_geometry', 'Curved copper edges require tessellation')
      return area(points) * (i ? -1 : 1) > 0 ? points : points.reverse()
    })
    return { pcbCopperPourId: pour.pcb_copper_pour_id, layer: pour.layer, polygon, ...layer(m, pour.layer) }
  })
  if (!pours.length) fail('ground_geometry', `${net.name}: no physical ground copper pours found`)
  let receiver: string
  if (m.groundReturn) receiver = selectPort(circuit, m.groundReturn).source_port_id
  else {
    const candidates = new Set<string>()
    for (const lane of mappings) for (const model of circuit.filter(e => e.type === 'simulation_ibis_model')) {
      for (const [pin, id] of Object.entries(model.ibis_pin_name_to_source_port_id)) if (id === lane.to) {
        const refs = model.ibis_pin_name_to_reference_source_port_ids?.[pin]
        for (const id of [refs?.pulldown_reference_source_port_id, refs?.ground_clamp_reference_source_port_id]) if (id && connected.has(id)) candidates.add(id)
      }
    }
    if (candidates.size !== 1) fail('ground_reference', 'Receiver IBIS bindings must identify one ground reference; otherwise set groundReturn')
    receiver = [...candidates][0]
  }
  if (!connected.has(receiver) || receiver === reference) fail('ground_reference', 'Distinct driver/receiver ground pins must connect to the same ground net')
  const signals = mappings.map(mapping => routePath(mapping.originalRoute, m))
  const connections = [reference, receiver].map(id => groundConnection(circuit, m, id, netIds, pours))
  const terminalPours = connections.map(path => pours.find(p => Math.abs((p.zMinMm + p.zMaxMm) / 2 - path.terminals[1][2]) < 1e-8 && contains(path.terminals[1].slice(0, 2) as Point, p.polygon)))
  if (!terminalPours[0] || terminalPours[0] !== terminalPours[1]) fail('ground_connectivity', 'Reference leads must reach one connected pour; inter-pour stitching extraction is not supported')
  const routedCopper: RoutedCopper = { sourceNetId: net.source_net_id, sourceNetName: net.name, referenceSourcePortIds: [reference, receiver], pours, signals, connections }
  const conductors = signals.map((path, i) => ({ name: `sig${i}`, lengthM: path.segments.reduce((s, p) => s + distance(p.a, p.b), 0) / 1000,
    widthM: Math.min(...path.segments.map(s => s.widthMm)) / 1000, thicknessM: Math.min(...path.segments.map(s => s.thicknessMm)) / 1000, yM: path.terminals[0][1] / 1000, zM: path.terminals[0][2] / 1000 }))
  conductors.push({ name: 'return', lengthM: distance(connections[0].terminals[0], connections[1].terminals[0]) / 1000,
    widthM: 0, thicknessM: (pours[0].zMaxMm - pours[0].zMinMm) / 1000, yM: 0, zM: (pours[0].zMaxMm + pours[0].zMinMm) / 2000 })
  return { mappings, cells: [{ stage: 0, profile: 'routed-copper', conductivitySm: m.conductivitySm, relativePermittivity: m.relativePermittivity!, conductors, routedCopper }],
    units: { circuitJson: 'mm', geometry: 'm', conductivity: 'S/m' }, approximations: [
      'Original routed signal coordinates and net-connected ground copper boundaries/cutouts; copper heights/thicknesses from stackup',
      'FastHenry ground polygons discretized into an adaptive rectangular conductor mesh; cutout boundaries rasterized and edge strips have mesh-dependent boundary extension; finite reference contact areas resolved locally; ground mesh and filaments refined together',
      'FasterCap uses closed polygon solids with 1e-12 mm integer-grid booleans, preserving pour cutouts; ground islands on the same electrical net treated as equipotential',
      'Only the driver and receiver reference leads/vias are extracted; other ground routing, reference stitching and package/PDN impedance omitted',
      'Via rectangular equivalent preserves plated barrel metal area; offset pad contacts use an inscribed strip; other pads and unused through-via stubs omitted; wire joins rounded',
      'Homogeneous explicit effective permittivity; other power copper, neighboring unselected nets, dielectric loss and copper roughness omitted',
      'Whole routed network R/L/C distributed into uniform pi sections; constant R/L at modelHz; broadband dispersion and spatially varying transmission-line parameters not fitted',
    ] }
}

