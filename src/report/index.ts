/**
 * report — human-facing rendering of a sealed PipelineResult.
 * Owns: report context (port labels, board SVG), CSV/HTML sections, escaping, the bundled
 * browser client (client/viewer-client.ts -> client/viewer-client.generated.ts at build).
 * Reads only typed result fields + result.files by paths the result itself names
 * (missing -> 'report_missing_artifact'); never recomputes physics. Output: a separate FileMap
 * (results.html, csv/*.csv).
 * Imports: kernel, board (port labels), simulation/ddr (types), pipeline (PipelineResult type).
 */
export { generateReport } from './render'
