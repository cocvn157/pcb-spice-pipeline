import { diagnostics, type DiagnosticInit } from '../kernel'

const raise = diagnostics('ddr', ['ddr_config', 'ddr_probe'] as const)
export type DdrCode = Parameters<typeof raise>[0]
/** Declared as a function so `never` narrows control flow at call sites. */
export function fail(code: DdrCode, text: string, init?: DiagnosticInit): never {
  return raise(code, text, init)
}
