import type { CircuitJson } from '../schema'
import { fail } from '../diagnostics'
import type { PcbTrace, PortSelector, RoutedPoint, SourcePort } from './types'

/** Native pcbPath keeps via dimensions on the associated physical record. */
export function resolveRouteVias(circuit: CircuitJson, trace: PcbTrace): RoutedPoint[] {
  return trace.route.map(point => {
    if(point.route_type==='through_pad') fail('route_type','Only wire/via routed primitives supported')
    if(point.route_type!=='via') return point
    const matches=circuit.filter(e=>e.type==='pcb_via').filter(via=>
      (via.pcb_trace_id===trace.pcb_trace_id||(via.source_trace_id!==undefined&&via.source_trace_id===trace.source_trace_id))&&
      (via.pcb_trace_id===undefined||via.pcb_trace_id===trace.pcb_trace_id)&&
      (via.source_trace_id===undefined||via.source_trace_id===trace.source_trace_id)&&
      via.subcircuit_id===trace.subcircuit_id&&
      Math.hypot(via.x-point.x,via.y-point.y)<1e-5)
    if(matches.length>1) fail('via_geometry',`${trace.pcb_trace_id}: ambiguous native via at ${point.x},${point.y}`)
    if(matches[0]&&(!matches[0].layers.includes(point.from_layer)||!matches[0].layers.includes(point.to_layer)))
      fail('via_geometry',`${trace.pcb_trace_id}: physical via layers disagree at ${point.x},${point.y}`)
    const holes=[point.hole_diameter,matches[0]?.hole_diameter].filter((v): v is number=>v!==undefined)
    if(!holes.length||holes.some(v=>!Number.isFinite(v)||v<=0||v!==holes[0]))
      fail('via_geometry',`${trace.pcb_trace_id}: missing, invalid or conflicting via hole diameters at ${point.x},${point.y}`)
    return {...point,hole_diameter:holes[0]}
  })
}

/** Finds exactly one source port by id or by component name plus pin, failing 'pin_mapping' when it is missing or ambiguous. */
export function selectPort(cj: CircuitJson,s: PortSelector | undefined): SourcePort {
  if(!s) fail('pin_mapping','Explicit physical source port selector required')
  if(s.sourcePortId) {
    const ports=cj.filter((e): e is SourcePort=>e.type==='source_port'&&e.source_port_id===s.sourcePortId)
    if(ports.length!==1) fail('pin_mapping',`${s.sourcePortId}: expected one source port, got ${ports.length}`)
    return ports[0]
  }
  const components=cj.filter(e=>e.type==='source_component').filter(e=>e.name===s.component)
  if(components.length!==1) fail('pin_mapping',`${s.component}: expected one source component, got ${components.length}; use sourcePortId in repeated scopes`)
  const component=components[0]
  const ports=cj.filter(e=>e.type==='source_port').filter(e=>e.source_component_id===component.source_component_id && (e.port_hints?.includes(s.port??'')||e.name===s.port||`pin${e.pin_number}`===s.port))
  if(ports.length!==1) fail('pin_mapping',`${s.component}.${s.port}: expected one source port, got ${ports.length}`)
  return ports[0]
}
