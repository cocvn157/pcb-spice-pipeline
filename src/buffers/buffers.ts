// The IBIS part of general-pipeline.ts runPipeline (hash pinning, loading, conversion, assembly).
import * as converter from '@tscircuit/ibis-to-spice'
import { sha256, type Artifact, type ArtifactScope, type Produced } from '../kernel'
import { fail } from './diagnostics'
import { loadModelSource } from './source'
import type { AdmittedBuffers, AssemblyEntry, BufferModeling, CompiledBuffer, IbisSources, LoadedModelSource, ModelRunDefinition, ModelSourceRequest } from './types'

/** Fails 'converter_version' unless the pinned upstream general converter is installed. Today's first IBIS check. */
export function assertConverter(): void {
  if (typeof converter.convertIbisModelToSpice !== 'function') fail('converter_version', 'Install the pinned upstream general IBIS converter')
}

/**
 * Validate modeling.ibisModelAssetSha256 and load every used model before any solver work, in
 * declaration order. Artifacts (under `scope`, the output root): inputs/ibis/<pipelineId>.ibs and
 * vendor-sources.json, byte-identical to today.
 */
export function admitBuffers(models: readonly ModelSourceRequest[], ibisSources: IbisSources, modeling: BufferModeling, scope: ArtifactScope): Produced<AdmittedBuffers> {
  const expectedHashes: unknown = modeling.ibisModelAssetSha256
  if (expectedHashes !== undefined && (!expectedHashes || typeof expectedHashes !== 'object' || Array.isArray(expectedHashes))) fail('vendor_hash', 'modeling.ibisModelAssetSha256 must map project-relative IBIS asset paths to SHA-256 hashes')
  const hashes = expectedHashes as Record<string, unknown> | undefined
  const loaded: LoadedModelSource[] = []
  for (const model of models) {
    const path = model.ibis_model_asset.project_relative_path
    let expected: string | undefined
    if (hashes !== undefined) {
      const pinned = hashes[path]
      if (typeof pinned !== 'string' || !/^[a-f0-9]{64}$/i.test(pinned)) fail('vendor_hash', `${path}: modeling.ibisModelAssetSha256 requires an expected 64-digit SHA-256 hash for each used IBIS asset`)
      expected = pinned
    }
    const source = loadModelSource(model, ibisSources)
    if (expected !== undefined && source.evidence.sourceSha256 !== expected.toLowerCase()) fail('vendor_hash', `${path}: IBIS asset bytes differ from modeling.ibisModelAssetSha256`)
    loaded.push(source)
  }
  const artifacts: Artifact[] = loaded.map(source => scope.text(source.evidence.ibsFile, source.text))
  artifacts.push(scope.json('vendor-sources.json', loaded.map(source => source.evidence)))
  return { value: { models: models.map(model => ({ pipelineId: model.pipelineId })), sources: loaded } as unknown as AdmittedBuffers, artifacts }
}

/**
 * Convert each plan's models (plan order, then model order), exactly as today: `define` builds the
 * converter input (simulation's modelRunDefinition), its source is pinned to the admitted bytes,
 * then convertIbisModelToSpice runs. Pure; converter errors propagate unchanged.
 */
export function compileBuffers<M extends { pipelineId: string; ibis_component_name: string }, P extends { readonly models: readonly M[] }>(
  admitted: AdmittedBuffers, plans: readonly P[], define: (model: M, plan: P) => ModelRunDefinition): CompiledBuffer[][] {
  return plans.map(plan => plan.models.map(model => {
    const index = admitted.models.findIndex(selected => selected.pipelineId === model.pipelineId)
    const input = define(model, plan)
    const source = admitted.sources[index]
    input.definition.source = { file: source.evidence.ibsFile, sha256: source.evidence.sourceSha256 }
    const result = converter.convertIbisModelToSpice(source.bytes, input.definition, input.run)
    return { ...result, name: model.ibis_component_name, pipelineId: model.pipelineId, input, sourceEvidence: admitted.sources[index].evidence }
  }))
}

/** One experiment's assembly evidence. Artifact: native-ibis-assembly.json under `experiment` (experiments/<id>). */
export function ibisAssembly(models: readonly CompiledBuffer[], experiment: ArtifactScope): Produced<AssemblyEntry[]> {
  const assembly: AssemblyEntry[] = models.map(model => ({
    simulationIbisModelId: model.pipelineId, definition: model.input.definition, run: model.input.run, spicePinMapping: model.spicePinMapping,
    sourceSha256: model.sourceSha256, spiceSha256: sha256(model.source), sourceEvidence: model.sourceEvidence, metadata: model.metadata, warnings: model.warnings,
  }))
  return { value: assembly, artifacts: [experiment.json('native-ibis-assembly.json', assembly)] }
}
