/**
 * buffers — IBIS driver/receiver models as SPICE.
 * Owns: IbisSources admission (path safety, size, ZIP/HTML rejection, UTF-8), SHA-256 pinning
 * (modeling.ibisModelAssetSha256), the pinned @tscircuit/ibis-to-spice converter, compiled
 * libraries and their evidence.
 * Order (today's runPipeline): assertConverter -> admitBuffers (pure checks, no solver work) ->
 * compileBuffers -> per experiment ibisAssembly. compileBuffers takes AdmittedBuffers, so it cannot run on unchecked bytes.
 * Artifacts: inputs/ibis/<id>.ibs, vendor-sources.json, experiments/<id>/native-ibis-assembly.json.
 * The `<id>.lib` bytes are CompiledBuffer.source; simulation hands them to ngspice (solver records them).
 * Imports: kernel, board (types). (Was: model-source.ts, IBIS parts of general-pipeline.ts.)
 */
export type { IbisSources, BufferModeling, ModelSourceRequest, ModelRunDefinition, SourceEvidence, LoadedModelSource, AdmittedBuffers, CompiledBuffer, AssemblyEntry } from './types.js'
export { relativeFile, loadModelSource } from './source.js'
export { assertConverter, admitBuffers, compileBuffers, ibisAssembly } from './buffers.js'
