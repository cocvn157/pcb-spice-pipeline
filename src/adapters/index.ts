/**
 * adapters — the `/node` entry. The only module allowed to import node:*.
 * Owns: createNativeSolver (temp workdir lifecycle, execFile, timeout, output collection),
 * loadIbisSources (traversal-safe fs reads), writePipelineOutput (FileMap + report to disk).
 * Imports: kernel, solver (types), buffers (IbisSources), board (CircuitJson), pipeline (types), report.
 * Package export "./node" points straight here — no src/node.ts pass-through.
 */
export { createNativeSolver, type NativeSolverOptions } from './native-solver'
export { loadIbisSources } from './ibis-fs'
export { writePipelineOutput } from './write-output'
