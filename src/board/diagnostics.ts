import { diagnostics, type DiagnosticInit } from '../kernel'

const raise = diagnostics('board', [
  'circuit_json', 'circuit_schema', 'modeling_input', 'reduction', 'lanes', 'pin_mapping', 'extraction', 'sections',
  'stackup', 'route_selection', 'empty_route', 'route_type', 'route_geometry', 'varying_width',
  'endpoint_position', 'endpoint_layer', 'stale_endpoint', 'via_geometry', 'via_stub', 'layer_transition',
  'return_geometry', 'conductor_overlap', 'lane_spacing', 'simulation_scope',
  'ground_net', 'ground_geometry', 'ground_reference', 'ground_connection', 'ground_connectivity',
] as const)
export type BoardCode = Parameters<typeof raise>[0]
/** Declared as a function so `never` narrows control flow at call sites. */
export function fail(code: BoardCode, text: string, init?: DiagnosticInit): never {
  return raise(code, text, init)
}
