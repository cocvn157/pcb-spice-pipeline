/**
 * pipeline — the run as an explicit state machine whose stages are values.
 * Owns: PipelineOptions/PipelineResult (designed, not inferred), the composite Modeling type
 * and modelingFromCircuitJson, the phase sequence, the validation line (no solver context
 * exists before phase 'bound'), artifact scopes handed to each domain, the ArtifactLedger
 * (sole writer of the output FileMap), limitations aggregation.
 * Owns no domain knowledge: each stage is a handful of calls into domain functions.
 * Artifacts: inputs/modeling.json, circuit-results.json.
 * Imports: every domain except report and adapters.
 */
export type { PipelineOptions, PipelineResult, ExperimentResult, EyeDescriptor } from './result'
export type { Modeling, PipelineModeling } from './modeling'
export { modelingFromCircuitJson } from './modeling'
export { runPipeline } from './run'
