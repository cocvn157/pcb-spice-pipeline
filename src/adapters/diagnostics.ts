import { diagnostics, type DiagnosticInit } from '../kernel/index.js'

/** Codes raised by today's src/node.ts (file_path via relativeFile/contained). */
const raise = diagnostics('adapters', ['file_path', 'native_solver', 'native_timeout'] as const)
export type AdaptersCode = Parameters<typeof raise>[0]
/** Declared as a function so `never` narrows control flow at call sites. */
export function fail(code: AdaptersCode, text: string, init?: DiagnosticInit): never { return raise(code, text, init) }
