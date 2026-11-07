import { diagnostics, type DiagnosticInit } from '../kernel/index.js'

/** Codes today's declarations.ts, general-spice.ts, stimulus.ts and the ngspice part of runPipeline raise. */
const raise = diagnostics('simulation', [
  'simulation_reference', 'simulation_experiment', 'simulation_capability', 'simulation_timing', 'simulation_scope', 'simulation_probe',
  'simulation_start', 'simulation_duration', 'native_declaration', 'native_solver', 'result_schema',
  'channel_short', 'channel_net', 'channel_fanout', 'channel_model', 'matrix_dimension',
  'ibis_model', 'ibis_mapping', 'ibis_state', 'ibis_contract',
  'stimulus_pattern', 'stimulus_coverage', 'stimulus_duplicate', 'stimulus_state', 'stimulus_missing',
  'probe_reference', 'probe_observation', 'eye_timing', 'eye_reference',
  'electrical_input', 'supply_reference', 'supply_short', 'supply_missing', 'source_edge', 'source_capability',
  'passive_reference', 'passive_capability', 'floating_source', 'floating_reference', 'spice_options',
] as const)
export type SimulationCode = Parameters<typeof raise>[0]
/** Declared as a function so `never` narrows control flow at call sites. */
export function fail(code: SimulationCode, text: string, init?: DiagnosticInit): never { return raise(code, text, init) }
