import { diagnostics, type DiagnosticInit } from '../kernel'

/** Codes today's model-source.ts and the IBIS part of general-pipeline.ts raise. */
const raise = diagnostics('buffers', ['converter_version', 'vendor_hash', 'ibis_asset', 'ibis_asset_missing', 'file_path'] as const)
export type BuffersCode = Parameters<typeof raise>[0]
/** Declared as a function so `never` narrows control flow at call sites. */
export function fail(code: BuffersCode, text: string, init?: DiagnosticInit): never { return raise(code, text, init) }
