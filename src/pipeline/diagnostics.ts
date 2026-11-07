import { diagnostics, type DiagnosticInit } from '../kernel'
// The pipeline owns only modelingFromCircuitJson's channel declaration check; every other failure
// belongs to the domain that detected it.
const raise = diagnostics('pipeline', ['pcb_spice_channel'] as const)
export type PipelineCode = Parameters<typeof raise>[0]
/** Declared as a function so `never` narrows control flow at call sites. */
export function fail(code: PipelineCode, text: string, init?: DiagnosticInit): never {
  return raise(code, text, init)
}
