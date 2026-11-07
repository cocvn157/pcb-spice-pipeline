import { diagnostics, type DiagnosticInit } from '../kernel'

const raise = diagnostics('extraction', [
  'native_convergence', 'native_geometry', 'native_solver', 'fasthenry_output', 'fasthenry_ports', 'fastercap_output',
  'fastercap_ports', 'matrix_format', 'matrix_zero', 'matrix_dimension', 'matrix_order', 'reciprocity', 'passivity',
  'reference', 'capacitance_sign', 'model_frequency', 'mesh_convergence', 'analytic_resistance', 'analytic_return',
  'cap_convergence', 'reference_energy', 'sections', 'ground_mesh', 'ground_geometry', 'copper_surface',
] as const)
export type ExtractionCode = Parameters<typeof raise>[0]
/** Declared as a function so `never` narrows control flow at call sites. */
export function fail(code: ExtractionCode, text: string, init?: DiagnosticInit): never {
  return raise(code, text, init)
}
