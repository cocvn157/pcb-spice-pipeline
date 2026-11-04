import earcut, { refine } from 'earcut'
import { Clipper64, PolyTree64, ClipType, FillRule, type PolyPath64 } from 'clipper2-ts'
import { fail } from './matrices.mjs'
import { selectPort, resolveRouteVias } from './geometry.js'
import type { CircuitJson } from './schema.js'
import type { ExtractionSettings, Geometry, GeometryCell, LaneMapping, ResolvedModeling } from './geometry.js'
import { subcircuitTree } from './subcircuit-scope.js'

type Point = [number, number]
type XYZ = [number, number, number]
type Polygon = Point[][]
type Solid = { polygon: Polygon; zMinMm: number; zMaxMm: number; conductivitySm?: number }
type Segment = { conductivitySm?: number; a: XYZ; b: XYZ; widthMm: number; thicknessMm: number }
type Path = { segments: Segment[]; terminals: [XYZ, XYZ]; contactRadiusMm?: number }
// FasterCap has absolute panel-area thresholds. Millimetre coordinates keep
// real fine copper edges numerically resolvable. Electrostatic capacitance
// scales linearly with length, so rescale the raw matrix back to SI farads.
export const copperCapacitanceScaleToFarads=1e-3
export interface RoutedCopper {
  sourceNetId: string
  sourceNetName: string
  referenceSourcePortIds: string[]
  pours: Array<Solid & { pcbCopperPourId: string; layer: string }>
  signals: Path[]
  connections: Path[]
}

const finite = (value: number) => Number.isFinite(value)
const distance = (a: XYZ, b: XYZ) => Math.hypot(...a.map((v, i) => v - b[i]))
const area = (ring: Point[]) => ring.reduce((s, p, i) => {
  const q = ring[(i + 1) % ring.length]; return s + p[0] * q[1] - q[0] * p[1]
}, 0) / 2
const closed = (ring: Point[]) => [...ring, ring[0]]
const layer = (m: ResolvedModeling, name: string) => {
  const found = m.stackup.find(l => l.name === name)
  if (!found) fail('stackup', `No copper z range for ${name}`)
  return found
}
const z = (m: ResolvedModeling, name: string) => { const l = layer(m, name); return (l.zMinMm + l.zMaxMm) / 2 }

/** Resolve net membership through electrical connections, never copper proximity. */
export function connectedSourceIds(circuit: CircuitJson, seed: string): Set<string> {
  const ids = new Set([seed]), traces = circuit.filter(e => e.type === 'source_trace')
  let changed = true
  while (changed) {
    changed = false
    for (const trace of traces) {
      const members = [...trace.connected_source_port_ids, ...(trace.connected_source_net_ids ?? [])]
      if (members.some(id => ids.has(id))) for (const id of members) if (!ids.has(id)) { ids.add(id); changed = true }
    }
  }
  return ids
}

const ringBounds=new WeakMap<Point[],[number,number,number,number]>()
function inRing(p: Point, ring: Point[]): boolean {
  let box=ringBounds.get(ring)
  if(!box) {box=[Math.min(...ring.map(p=>p[0])),Math.min(...ring.map(p=>p[1])),Math.max(...ring.map(p=>p[0])),Math.max(...ring.map(p=>p[1]))];ringBounds.set(ring,box)}
  if(p[0]<box[0]||p[1]<box[1]||p[0]>box[2]||p[1]>box[3]) return false
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j]
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}
const contains = (p: Point, polygon: Polygon) => inRing(p, polygon[0]) && !polygon.slice(1).some(ring => inRing(p, ring))

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
  const joined = joinShortSegments(segments)
  return { segments: joined, terminals: [joined[0].a, joined.at(-1)!.b] }
}

/** EXPERIMENT (#46): FastHenry models a segment as a box, and finely sampled
 * curves give pieces shorter than the trace width whose boxes overlap at each
 * joint ("mutual inductance = infinity"). Join consecutive same-layer pieces
 * of equal width/thickness until each chord is at least one trace width long.
 * Route ends, vias and width changes keep their exact coordinates. */
export function joinShortSegments(segments: Segment[]): Segment[] {
  const same = (s: Segment, t: Segment) => s.a[2] === s.b[2] && t.a[2] === t.b[2] && s.a[2] === t.a[2]
    && s.widthMm === t.widthMm && s.thicknessMm === t.thicknessMm && s.conductivitySm === t.conductivitySm
  const out: Segment[] = []
  let i = 0
  while (i < segments.length) {
    const start = segments[i]
    let j = i
    while (j + 1 < segments.length && same(start, segments[j + 1]) && distance(start.a, segments[j].b) < start.widthMm) j++
    out.push({ ...start, b: segments[j].b })
    i = j + 1
    // A short tail before a via, width change or route end joins the previous chord.
    const last = out.at(-1)!, previous = out.at(-2)
    if (previous && distance(last.a, last.b) < last.widthMm && same(previous, last) && (i >= segments.length || !same(last, segments[i])))
      out.splice(-2, 2, { ...previous, b: last.b })
  }
  return out
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

/** Same-net pours that touch or overlap on one layer are one conductor. Boards
 * often tile a plane from adjacent regions; meshing each region separately
 * puts coincident conductors on every shared edge, which FastHenry rejects
 * ("filaments had identical centers"). Disjoint islands stay separate. */
export function mergeLayerPours(pours: RoutedCopper['pours']): RoutedCopper['pours'] {
  const merged: RoutedCopper['pours'] = []
  for (const layerName of [...new Set(pours.map(p => p.layer))]) {
    const group = pours.filter(p => p.layer === layerName)
    if (group.length === 1) { merged.push(group[0]); continue }
    const bounds = (ring: Point[]) => [Math.min(...ring.map(p => p[0])), Math.min(...ring.map(p => p[1])), Math.max(...ring.map(p => p[0])), Math.max(...ring.map(p => p[1]))]
    for (const polygon of copperBoolean(group.map(p => p.polygon))) {
      const rings = polygon.map((ring, i) => {
        const open = ring.slice(0, -1)
        return area(open) * (i ? -1 : 1) > 0 ? open : open.reverse()
      })
      const [x0, y0, x1, y1] = bounds(rings[0])
      const ids = group.filter(p => { const [a, b, c, d] = bounds(p.polygon[0]); return a <= x1 && c >= x0 && b <= y1 && d >= y0 }).map(p => p.pcbCopperPourId)
      merged.push({ ...group[0], pcbCopperPourId: ids.join('+'), polygon: rings })
    }
  }
  return merged
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
  const sourcePours: RoutedCopper['pours'] = circuit.filter(e => e.type === 'pcb_copper_pour').filter(e => netIds.has(e.source_net_id ?? '')).map(pour => {
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
  const pours = mergeLayerPours(sourcePours)
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

/** Same edge-strip discretization as a rectangular plane mesh, refined locally
 * around boundaries and finite contacts. Every retained cell lies inside copper.
 * Adjacent cells contribute half their transverse width to their shared edge.
 */
export function groundMesh(pour: Solid, meshMm: number, contacts: Array<{point:Point;radius:number}>, contactDivisions=2) {
  const points: Point[]=[], edges: Array<[number,number,number]>=[], indices=new Map<string,number>()
  const node=(x:number,y:number)=>{
    const key=`${x.toFixed(10)},${y.toFixed(10)}`
    let index=indices.get(key)
    if(index===undefined) {index=points.length;indices.set(key,index);points.push([x,y])}
    return index
  }
  const lines=new Map<string,{horizontal:boolean;fixed:number;intervals:Array<[number,number,number]>}>()
  const add=(horizontal:boolean,fixed:number,a:number,b:number,width:number)=>{
    const key=`${horizontal}:${fixed.toFixed(10)}`
    if(!lines.has(key)) lines.set(key,{horizontal,fixed,intervals:[]})
    lines.get(key)!.intervals.push([a,b,width])
  }
  const ring=pour.polygon[0],xs=ring.map(p=>p[0]),ys=ring.map(p=>p[1])
  const boundary=pour.polygon.flatMap(r=>r.map((a,i)=>({a,b:r[(i+1)%r.length]})))
  const visit=(x0:number,y0:number,x1:number,y1:number,borders:typeof boundary,depth:number)=>{
    const crosses=borders.filter(({a,b})=>Math.max(a[0],b[0])>x0+1e-9&&Math.min(a[0],b[0])<x1-1e-9&&Math.max(a[1],b[1])>y0+1e-9&&Math.min(a[1],b[1])<y1-1e-9)
    const center:Point=[(x0+x1)/2,(y0+y1)/2],inside=contains(center,pour.polygon),size=Math.max(x1-x0,y1-y0)
    if(!crosses.length&&!inside) return
    let target=crosses.length?meshMm/4:meshMm
    for(const c of contacts) {
      const dx=Math.max(x0-c.point[0],0,c.point[0]-x1),dy=Math.max(y0-c.point[1],0,c.point[1]-y1)
      if(Math.hypot(dx,dy)<c.radius) target=Math.min(target,c.radius/contactDivisions)
    }
    if(size>target&&depth<28) {
      if(x1-x0>=y1-y0) {const mid=(x0+x1)/2;visit(x0,y0,mid,y1,crosses,depth+1);visit(mid,y0,x1,y1,crosses,depth+1)}
      else {const mid=(y0+y1)/2;visit(x0,y0,x1,mid,crosses,depth+1);visit(x0,mid,x1,y1,crosses,depth+1)}
    } else if(inside&&!crosses.length) {
      add(true,y0,x0,x1,(y1-y0)/2);add(true,y1,x0,x1,(y1-y0)/2)
      add(false,x0,y0,y1,(x1-x0)/2);add(false,x1,y0,y1,(x1-x0)/2)
    }
  }
  visit(Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys),boundary,0)
  for(const line of lines.values()) {
    const events=new Map<number,number>()
    for(const [a,b,w] of line.intervals) {events.set(a,(events.get(a)??0)+w);events.set(b,(events.get(b)??0)-w)}
    const positions=[...events.keys()].sort((a,b)=>a-b)
    let width=0
    for(let i=0;i<positions.length-1;i++) {
      const a=positions[i],b=positions[i+1];width+=events.get(a)!
      if(width>1e-10&&b-a>1e-10) edges.push([line.horizontal?node(a,line.fixed):node(line.fixed,a),line.horizontal?node(b,line.fixed):node(line.fixed,b),width])
    }
  }
  const groups=contacts.map(c=>points.flatMap((p,i)=>Math.hypot(p[0]-c.point[0],p[1]-c.point[1])<=c.radius?[i]:[]))
  if(groups.some(g=>g.length<4)) fail('ground_mesh','Reference contact area is unresolved; decrease extraction.groundMeshMm')
  const parents=points.map((_,i)=>i),root=(i:number):number=>parents[i]===i?i:(parents[i]=root(parents[i]))
  for(const [a,b] of edges) parents[root(a)]=root(b)
  if(groups.length>1&&groups.some(g=>root(g[0])!==root(groups[0][0]))) fail('ground_mesh','Ground mesh disconnects reference contacts; decrease extraction.groundMeshMm')
  return {points,edges,contacts:groups}
}

/** FastHenry conductor mesh follows the selected polygon, including every cutout. */
export function copperFastHenryDeck(cell: GeometryCell, extraction: ExtractionSettings): string {
  const copper = cell.routedCopper!, mesh = extraction.groundMeshMm!
  const lines = ['* Actual routed signals and inferred ground copper; dimensions in metres', '.units m', `.default sigma=${cell.conductivitySm} nhinc=${extraction.filaments} nwinc=${extraction.filaments}`]
  const coordinates = (p: XYZ) => `x=${p[0] / 1000} y=${p[1] / 1000} z=${p[2] / 1000}`
  let serial = 0
  const path = (p: Path, a: string, b: string) => {
    if (!p.segments.length) { lines.push(`${a} ${coordinates(p.terminals[0])}`); if (a !== b) lines.push(`${b} ${coordinates(p.terminals[0])}`, `.equiv ${a} ${b}`); return }
    const names = [a, ...p.segments.slice(1).map(() => `Nt${serial++}`), b]
    lines.push(`${names[0]} ${coordinates(p.segments[0].a)}`)
    for (const [i, s] of p.segments.entries()) {
      lines.push(`${names[i + 1]} ${coordinates(s.b)}`)
      const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], horizontal = Math.hypot(dx, dy)
      lines.push(`E${serial++} ${names[i]} ${names[i + 1]} w=${s.widthMm / 1000} h=${s.thicknessMm / 1000} sigma=${s.conductivitySm??cell.conductivitySm} wx=${horizontal ? -dy / horizontal : 1} wy=${horizontal ? dx / horizontal : 0} wz=0`)
    }
  }
  copper.signals.forEach((p, i) => path(p, `N${i}a`, `N${i}b`))
  const n = copper.signals.length
  copper.connections.forEach((p, i) => path(p, `N${n}${i ? 'b' : 'a'}`, `Ng${i}`))
  for (const [index, pour] of copper.pours.entries()) {
    const contacts = copper.connections.map((p, i) => ({ p, i })).filter(({ p }) => Math.abs((pour.zMinMm + pour.zMaxMm) / 2 - p.terminals[1][2]) < 1e-8 && contains(p.terminals[1].slice(0, 2) as Point, pour.polygon))
    const ground = groundMesh(pour, mesh, contacts.map(({p})=>({point:p.terminals[1].slice(0,2) as Point,radius:p.contactRadiusMm!})),Math.max(2,Math.ceil(Math.sqrt(extraction.filaments))))
    const zz = (pour.zMinMm + pour.zMaxMm) / 2000, thickness = (pour.zMaxMm - pour.zMinMm) / 1000
    lines.push(`* ${pour.pcbCopperPourId} layer=${pour.layer} cutouts=${pour.polygon.length-1} meshMm=${mesh}`)
    ground.points.forEach((p,j)=>lines.push(`Np${index}_${j} x=${p[0]/1000} y=${p[1]/1000} z=${zz}`))
    ground.edges.forEach(([a,b,width],j)=>{
      const [u,v]=[ground.points[a],ground.points[b]],dx=v[0]-u[0],dy=v[1]-u[1],length=Math.hypot(dx,dy)
      lines.push(`Eg${index}_${j} Np${index}_${a} Np${index}_${b} w=${width/1000} h=${thickness} sigma=${pour.conductivitySm??cell.conductivitySm} wx=${-dy/length} wy=${dx/length} wz=0 nwinc=1 nhinc=${extraction.filaments}`)
    })
    contacts.forEach(({i},j)=>ground.contacts[j].forEach(id=>lines.push(`.equiv Ng${i} Np${index}_${id}`)))
  }
  for (let i = 0; i <= n; i++) lines.push(`.external N${i}a N${i}b`)
  lines.push(`.freq fmin=${extraction.minimumHz} fmax=${extraction.maximumHz} ndec=1`, '.end')
  return lines.join('\n') + '\n'
}

function pathSolids(path: Path): Solid[] {
  const solids: Solid[] = []
  for (const s of path.segments) {
    const [x, y, zz] = s.a, [xx, yy, zzz] = s.b, length = Math.hypot(xx - x, yy - y)
    if (!length) {
      const w = s.widthMm / 2, h = s.thicknessMm / 2
      solids.push({ polygon: [[[x - w, y - h], [x + w, y - h], [x + w, y + h], [x - w, y + h]]], zMinMm: Math.min(zz, zzz), zMaxMm: Math.max(zz, zzz) })
    } else {
      const dx = -(yy - y) * s.widthMm / (2 * length), dy = (xx - x) * s.widthMm / (2 * length)
      const limits = { zMinMm: zz - s.thicknessMm / 2, zMaxMm: zz + s.thicknessMm / 2 }
      solids.push({ polygon: [[[x + dx, y + dy], [x - dx, y - dy], [xx - dx, yy - dy], [xx + dx, yy + dy]]], ...limits })
      for (const p of [s.a, s.b]) solids.push({ polygon: [Array.from({ length: 16 }, (_, i): Point => [p[0] + s.widthMm / 2 * Math.cos(2 * Math.PI * i / 16), p[1] + s.widthMm / 2 * Math.sin(2 * Math.PI * i / 16)])], ...limits })
    }
  }
  return solids
}

/** Boolean slab union removes internal faces at bends, vias and pour contacts. */
// Boolean intersections can leave duplicate/collinear vertices separated only
// by floating-point roundoff. This 10-picometre tolerance is below the saved
// board's nanometre coordinate precision; raw source polygons stay unchanged.
const copperEpsilonMm=1e-8
// Boolean geometry uses a local 1e-12 mm integer grid. Keep the source
// route unchanged and retain holes/islands through the clipping hierarchy.
function copperBoolean(subject: Polygon[], clip?: Polygon[]): Polygon[] {
  const scale=1e12, engine=new Clipper64(), tree=new PolyTree64(), result: Polygon[]=[]
  const paths=(polygons: Polygon[])=>polygons.flatMap(p=>p.map((ring,i)=>{
    const oriented=area(ring)*(i?-1:1)>0?ring:[...ring].reverse()
    return oriented.map(([x,y])=>{
      const point={x:Math.round(x*scale),y:Math.round(y*scale)}
      if(!Number.isSafeInteger(point.x)||!Number.isSafeInteger(point.y)) fail('copper_surface','Copper coordinates exceed the integer clipping range')
      return point
    })
  }))
  engine.addSubject(paths(subject))
  if(clip) engine.addClip(paths(clip))
  if(!engine.execute(clip?ClipType.Difference:ClipType.Union,FillRule.NonZero,tree)) fail('copper_surface','Copper polygon clipping failed')
  const ring=(node: PolyPath64)=>closed(node.polygon!.map(p=>[p.x/scale,p.y/scale] as Point))
  const visit=(node: PolyPath64)=>{
    if(node.polygon&&!node.isHole) result.push([ring(node),...Array.from({length:node.count},(_,i)=>ring(node.child(i)))])
    for(let i=0;i<node.count;i++) visit(node.child(i))
  }
  visit(tree)
  return cleanPolygons(result)
}
function cleanPolygons(polygons: Polygon[]): Polygon[] {
  const result: Polygon[]=[]
  for(const polygon of polygons) {
    const rings: Polygon=[]
    for(const ring of polygon) {
      let points=ring.slice(0,-1).filter((p,i)=>i===0||Math.hypot(p[0]-ring[i-1][0],p[1]-ring[i-1][1])>copperEpsilonMm)
      let changed=true
      while(changed&&points.length>=3) {
        changed=false
        points=points.filter((p,i)=>{
          const a=points[(i+points.length-1)%points.length],b=points[(i+1)%points.length]
          const u:Point=[p[0]-a[0],p[1]-a[1]],v:Point=[b[0]-p[0],b[1]-p[1]]
          const length=Math.max(Math.hypot(...u),Math.hypot(...v)),cross=Math.abs(u[0]*v[1]-u[1]*v[0])
          const remove=length===0||cross<=copperEpsilonMm*length&&u[0]*v[0]+u[1]*v[1]>=-(copperEpsilonMm**2)
          if(remove) changed=true
          return !remove
        })
      }
      if(points.length>=3&&Math.abs(area(points))>copperEpsilonMm**2) rings.push(closed(points))
      else if(rings.length===0) break
    }
    if(rings.length) result.push(rings)
  }
  return result
}

// FasterCap panel sizing for routed copper (#28). Huge, extremely thin input panels
// (a 12.6 mm pour face as two triangles, 12.6 mm x 8 um pour sides, 10 mm x 35 um
// trace sides) make FasterCap's collocation system ill-conditioned (hundreds of
// GMRES iterations) and leave C dependent on the -a tolerance. Panels are
// therefore pre-shaped: target edge h(x) = min + grading * distance-to-signal,
// clamped to [min, max]; side walls are split so no panel is longer than
// panelAspectLimit times the copper thickness.
export interface PanelSizing { sizeAt: (p: XYZ) => number; aspectLimit: number }
export const panelAspectLimit = 10, panelGrading = 0.5

// Graded parameters along a segment, independent of its direction so the faces
// on both sides of a shared edge get the same points.
function gradedSplit(a: Point, b: Point, size: (p: Point) => number): number[] {
  const flip = a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]), [p, q] = flip ? [b, a] : [a, b]
  const length = Math.hypot(q[0] - p[0], q[1] - p[1]), ts = [0]
  let t = 0, step = 0
  for (;;) {
    const h = size([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t])
    if (!(h > 0) || !finite(h)) fail('copper_surface', 'Copper panel size must be finite and positive')
    step = h / length
    if (t + step >= 1 - 1e-9) break
    t += step; ts.push(t)
    if (ts.length > 1e6) fail('copper_surface', 'Copper panel sizing produced too many panels')
  }
  // The walk overshoots 1; shrink every piece uniformly so none exceeds its size and the last is no sliver.
  const out = [...ts, t + step].map(v => v / (t + step))
  out[out.length - 1] = 1
  return flip ? out.map(v => 1 - v).reverse() : out
}

// Quality triangulation of one polygon with holes. earcut + refine gives the
// constrained Delaunay triangulation of the polygon vertices; boundary edges are
// then split by gradedSplit, graded quadtree points are inserted inside, and
// Lawson flips (earcut refine) restore the constrained Delaunay mesh.
export function meshPolygon(rings: Point[][], size: (p: Point) => number): Point[][] {
  const pts: Point[] = rings.flat().map(p => [p[0], p[1]]), starts: number[] = []
  let count = rings[0].length
  for (const r of rings.slice(1)) { starts.push(count); count += r.length }
  let tris: number[][] = []
  const key = (i: number, j: number) => i < j ? `${i},${j}` : `${j},${i}`
  let edgeTris = new Map<string, Set<number>>()
  const link = (ti: number) => { const t = tris[ti]; for (let e = 0; e < 3; e++) { const k = key(t[e], t[(e + 1) % 3]); let set = edgeTris.get(k); if (!set) edgeTris.set(k, set = new Set()); set.add(ti) } }
  const unlink = (ti: number) => { const t = tris[ti]; for (let e = 0; e < 3; e++) edgeTris.get(key(t[e], t[(e + 1) % 3]))!.delete(ti) }
  const listeners: Array<(ti: number) => void> = []
  const replace = (ti: number, t: number[]) => { unlink(ti); tris[ti] = t; link(ti); listeners.forEach(f => f(ti)) }
  const add = (t: number[]) => { tris.push(t); link(tris.length - 1); listeners.forEach(f => f(tris.length - 1)) }
  const splitEdge = (a: number, b: number, m: number) => {
    for (const ti of [...edgeTris.get(key(a, b))!]) {
      const t = tris[ti], e = [0, 1, 2].find(e => key(t[e], t[(e + 1) % 3]) === key(a, b))!
      const [x, y, z] = [t[e], t[(e + 1) % 3], t[(e + 2) % 3]]
      replace(ti, [x, m, z]); add([m, y, z])
    }
  }
  const delaunay = (indices: number[]) => {
    refine(indices, pts.flat())
    tris = []; for (let i = 0; i < indices.length; i += 3) tris.push(indices.slice(i, i + 3))
    edgeTris = new Map(); tris.forEach((_, ti) => link(ti))
  }
  delaunay(earcut(pts.flat(), starts))
  // earcut can leave a T-junction where a hole edge is collinear with a triangle
  // edge (two vias in a row); split that edge at the vertex lying on it.
  for (let fixed = true; fixed;) {
    fixed = false
    for (const [k, set] of edgeTris) {
      if (set.size !== 1) continue
      const [a, b] = k.split(',').map(Number), A = pts[a], B = pts[b], dx = B[0] - A[0], dy = B[1] - A[1], l2 = dx * dx + dy * dy
      const v = pts.findIndex((P, i) => {
        if (i === a || i === b) return false
        const t = ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / l2
        return t > 1e-9 && t < 1 - 1e-9 && Math.abs((P[0] - A[0]) * dy - (P[1] - A[1]) * dx) <= 1e-12 * l2
      })
      if (v >= 0) { splitEdge(a, b, v); fixed = true; break }
    }
  }
  // The T-junction repair may already have split a ring edge at vertices lying
  // on it (a ring that touches itself). Grade each existing piece in order.
  const along = (A: Point, B: Point, P: Point) => ((P[0] - A[0]) * (B[0] - A[0]) + (P[1] - A[1]) * (B[1] - A[1])) / ((B[0] - A[0]) ** 2 + (B[1] - A[1]) ** 2)
  const pieces = (ia: number, ib: number): number[] => {
    if (edgeTris.get(key(ia, ib))?.size) return [ia, ib]
    const A = pts[ia], B = pts[ib], dx = B[0] - A[0], dy = B[1] - A[1], l2 = dx * dx + dy * dy
    const inner = pts.map((P, i) => ({ i, t: along(A, B, P) })).filter(({ i, t }) => i !== ia && i !== ib && t > 1e-9 && t < 1 - 1e-9 &&
      Math.abs((pts[i][0] - A[0]) * dy - (pts[i][1] - A[1]) * dx) <= 1e-12 * l2).sort((u, w) => u.t - w.t).map(({ i }) => i)
    const chain = [ia, ...inner, ib]
    if (chain.slice(1).some((w, k) => !edgeTris.get(key(chain[k], w))?.size)) fail('ground_geometry', 'Copper ring edge is missing from its triangulation')
    return chain
  }
  let base = 0
  for (const r of rings) {
    r.forEach((_, i) => {
      const ia = base + i, ib = base + (i + 1) % r.length, A = pts[ia], B = pts[ib], chain = pieces(ia, ib)
      let piece = 1, previous = ia
      for (const t of gradedSplit(A, B, size).slice(1, -1)) {
        while (piece < chain.length - 1 && along(A, B, pts[chain[piece]]) <= t) previous = chain[piece++]
        if (Math.abs(along(A, B, pts[chain[piece]]) - t) < 1e-9 || Math.abs(along(A, B, pts[previous]) - t) < 1e-9) continue
        pts.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]); splitEdge(previous, chain[piece], pts.length - 1); previous = pts.length - 1
      }
    })
    base += r.length
  }
  delaunay(tris.flat())
  const segments = rings.flatMap(r => r.map((p, i): [Point, Point] => [p, r[(i + 1) % r.length]]))
  const segmentDistance = (p: Point, [a, b]: [Point, Point]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
  }
  const inside = (p: Point) => segments.reduce((k, [a, b]) => (a[1] > p[1]) !== (b[1] > p[1]) && p[0] < a[0] + (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) ? !k : k, false)
  const xs = rings[0].map(p => p[0]), ys = rings[0].map(p => p[1]), x0 = Math.min(...xs), y0 = Math.min(...ys)
  const width = Math.max(...xs) - x0, height = Math.max(...ys) - y0, side = Math.min(width, height)
  const nx = Math.max(1, Math.round(width / side)), ny = Math.max(1, Math.round(height / side)), levels: Point[][] = []
  // Graded quadtree: a leaf is split while it is larger than the local size; its
  // centre becomes a vertex if it is clear of the boundary by half the leaf.
  const visit = (x: number, y: number, w: number, h: number, depth: number) => {
    const centre: Point = [x + w / 2, y + h / 2], s = Math.max(w, h)
    if (s > size(centre) && depth < 30) { for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) visit(x + i * w / 2, y + j * h / 2, w / 2, h / 2, depth + 1); return }
    if (inside(centre) && Math.min(...segments.map(sg => segmentDistance(centre, sg))) >= .45 * s) (levels[depth] ??= []).push(centre)
  }
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) visit(x0 + i * width / nx, y0 + j * height / ny, width / nx, height / ny, 0)
  for (const level of levels) {
    if (!level) continue
    const cell = Math.max(width, height) / Math.max(8, Math.sqrt(tris.length)), grid = new Map<string, Set<number>>()
    const register = (ti: number) => {
      const t = tris[ti].map(i => pts[i]), bx = t.map(p => p[0]), by = t.map(p => p[1])
      for (let gx = Math.floor((Math.min(...bx) - x0) / cell); gx <= Math.floor((Math.max(...bx) - x0) / cell); gx++)
        for (let gy = Math.floor((Math.min(...by) - y0) / cell); gy <= Math.floor((Math.max(...by) - y0) / cell); gy++) {
          const k = `${gx},${gy}`; let set = grid.get(k); if (!set) grid.set(k, set = new Set()); set.add(ti)
        }
    }
    tris.forEach((_, ti) => register(ti)); listeners.push(register)
    for (const p of level) {
      const located = [...grid.get(`${Math.floor((p[0] - x0) / cell)},${Math.floor((p[1] - y0) / cell)}`) ?? []].some(ti => {
        const [a, b, c] = tris[ti], [A, B, C] = [pts[a], pts[b], pts[c]], d = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])
        const l1 = ((B[0] - p[0]) * (C[1] - p[1]) - (B[1] - p[1]) * (C[0] - p[0])) / d, l2 = ((C[0] - p[0]) * (A[1] - p[1]) - (C[1] - p[1]) * (A[0] - p[0])) / d, l3 = 1 - l1 - l2, eps = 1e-9
        if (l1 < -eps || l2 < -eps || l3 < -eps) return false
        pts.push(p); const m = pts.length - 1
        if (l1 <= eps) splitEdge(b, c, m); else if (l2 <= eps) splitEdge(c, a, m); else if (l3 <= eps) splitEdge(a, b, m)
        else { replace(ti, [a, b, m]); add([b, c, m]); add([c, a, m]) }
        return true
      })
      if (!located) fail('copper_surface', 'Copper panel refinement could not place an interior vertex')
    }
    listeners.pop(); delaunay(tris.flat())
  }
  return tris.map(t => t.map(i => pts[i]))
}

function surfacePanels(solids: Solid[], name: string, sizing?: PanelSizing): string {
  const levels = [...new Set(solids.flatMap(s => [s.zMinMm, s.zMaxMm]))].sort((a, b) => a - b), rows = ['* Closed union of actual copper polygons; millimetres; physical capacitance = raw matrix * 0.001']
  const slabs = levels.slice(1).map((high, i) => {
    const low = levels[i], active = solids.filter(s => s.zMinMm < high - 1e-10 && s.zMaxMm > low + 1e-10)
    return active.length ? copperBoolean(active.map(s=>s.polygon)) : []
  })
  const emit = (kind: 'T' | 'Q', pts: XYZ[]) => rows.push(`${kind} ${name} ${pts.flat().join(' ')}`)
  const face = (polys: Polygon[], zz: number, up: boolean) => {
    for (const p of cleanPolygons(polys)) {
      const rings = p.map(r => r.slice(0, -1))
      const polygonArea = Math.abs(area(rings[0])) - rings.slice(1).reduce((s, r) => s + Math.abs(area(r)), 0)
      let triangles: Point[][]
      if (sizing) triangles = meshPolygon(rings, q => sizing.sizeAt([q[0], q[1], zz]))
      else {
        const points = rings.flat(), starts: number[] = []
        let count = rings[0].length
        for (const r of rings.slice(1)) { starts.push(count); count += r.length }
        const flat = points.flat(), indices = earcut(flat, starts)
        refine(indices, flat)
        triangles = []; for (let i = 0; i < indices.length; i += 3) triangles.push(indices.slice(i, i + 3).map(index => points[index]))
      }
      let trianglesArea = 0
      for (const triangle of triangles) {
        trianglesArea += Math.abs(area(triangle))
        if ((area(triangle) > 0) !== up) triangle.reverse()
        emit('T', triangle.map(p => [p[0], p[1], zz]))
      }
      if (Math.abs(trianglesArea - polygonArea) > Math.max(1e-8, polygonArea * 1e-8)) fail('copper_surface', 'Copper triangulation does not preserve polygon area/cutouts')
    }
  }
  for (let i = 0; i < slabs.length; i++) {
    const slab = slabs[i], previous = slabs[i - 1] ?? [], next = slabs[i + 1] ?? []
    if (!slab.length) continue
    const z0 = levels[i], z1 = levels[i + 1], thickness = z1 - z0
    face(previous.length ? copperBoolean(slab, previous) : slab, z0, false)
    face(next.length ? copperBoolean(slab, next) : slab, z1, true)
    for (const p of slab) for (const ring of p) for (let j = 1; j < ring.length; j++) {
      const a = ring[j - 1], b = ring[j]
      const ts = sizing ? gradedSplit(a, b, q => Math.min(sizing.sizeAt([q[0], q[1], (z0 + z1) / 2]), sizing.aspectLimit * thickness)) : [0, 1]
      for (let k = 1; k < ts.length; k++) {
        const u = [a[0] + (b[0] - a[0]) * ts[k - 1], a[1] + (b[1] - a[1]) * ts[k - 1]], v = [a[0] + (b[0] - a[0]) * ts[k], a[1] + (b[1] - a[1]) * ts[k]]
        const along = Math.hypot(v[0] - u[0], v[1] - u[1]), size = sizing ? Math.min(sizing.sizeAt([u[0], u[1], z0]), sizing.aspectLimit * along) : thickness
        const nz = Math.max(1, Math.ceil(thickness / size - 1e-9))
        for (let m = 0; m < nz; m++) {
          const za = m ? z0 + thickness * m / nz : z0, zb = m + 1 < nz ? z0 + thickness * (m + 1) / nz : z1
          emit('Q', [[u[0], u[1], za], [v[0], v[1], za], [v[0], v[1], zb], [u[0], u[1], zb]])
        }
      }
    }
  }
  return rows.join('\n') + '\n'
}

/** Graded panel size: finest on and near the signal copper, growing with distance up to maxPanelLengthMm. */
export function copperPanelSizing(copper: RoutedCopper, maxPanelLengthMm: number): PanelSizing {
  const segments = copper.signals.flatMap(path => path.segments)
  const minimum = Math.min(maxPanelLengthMm, ...segments.map(s => s.widthMm / 2))
  const distance = (p: XYZ) => Math.min(...segments.map(s => {
    const d = s.b.map((v, i) => v - s.a[i]), l2 = d.reduce((sum, v) => sum + v * v, 0)
    const t = l2 ? Math.max(0, Math.min(1, d.reduce((sum, v, i) => sum + v * (p[i] - s.a[i]), 0) / l2)) : 0
    return Math.max(0, Math.hypot(...p.map((v, i) => v - s.a[i] - t * d[i])) - Math.max(s.widthMm, s.thicknessMm) / 2)
  }))
  return { aspectLimit: panelAspectLimit, sizeAt: p => Math.min(maxPanelLengthMm, minimum + panelGrading * distance(p)) }
}

export function copperFasterCapDeck(cell: GeometryCell, extraction?: Pick<ExtractionSettings, 'maxPanelLengthMm'>): Record<string, string> {
  const copper = cell.routedCopper!, files: Record<string, string> = {}, list = ['* Actual routed copper in millimetres; physical capacitance = raw matrix * 0.001; homogeneous dielectric']
  const solids = [...copper.signals.map(pathSolids), [...copper.pours, ...copper.connections.flatMap(pathSolids)]]
  const sizing = extraction ? copperPanelSizing(copper, extraction.maxPanelLengthMm) : undefined
  solids.forEach((pieces, i) => {
    const name = i === copper.signals.length ? 'return' : `sig${i}`
    files[`${name}.txt`] = surfacePanels(pieces, name, sizing)
    list.push(`C ${name}.txt ${cell.relativePermittivity} 0 0 0`)
  })
  files['channel.lst'] = list.join('\n') + '\n'
  return files
}
