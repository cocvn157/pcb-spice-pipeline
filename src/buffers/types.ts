import type { ConvertedGeneralIbisComponent, IbisConversionMetadata, IbisModelDefinition, IbisRunConfig } from '@tscircuit/ibis-to-spice'
import type { SimulationIbisModel } from '../board'

export type IbisSources = Record<string, Uint8Array | string>
/** buffers' slice of the public `PipelineModeling`. Validated by admitBuffers: project-relative path -> 64-hex SHA-256. */
export interface BufferModeling { ibisModelAssetSha256?: Record<string, string> }

/** What loading needs from a declared model (today's `Pick<SimulationIbisModel,'ibis_model_asset'> & {pipelineId}`). */
export type ModelSourceRequest = Pick<SimulationIbisModel, 'ibis_model_asset'> & { pipelineId: string }
/** Converter input for one model in one experiment (was declarations.ts ModelRunDefinition). */
export interface ModelRunDefinition { definition: IbisModelDefinition; run: IbisRunConfig }

/** One `vendor-sources.json` entry. Key order is serialized. */
export interface SourceEvidence {
  simulationIbisModelId: string
  ibisModelAsset: SimulationIbisModel['ibis_model_asset']
  resolvedFrom: 'provided'
  ibsFile: string
  sourceSha256: string
  rawSourceFile: string
  rawSourceSha256: string
}
/** Today's loadModelSource return value. */
export interface LoadedModelSource { text: string; bytes: Uint8Array; evidence: SourceEvidence }

declare const admittedBrand: unique symbol
/** Every used model loaded, decoded and (if pinned) hash-verified, in declaration order. Only admitBuffers builds one. */
export interface AdmittedBuffers {
  readonly [admittedBrand]: true
  readonly models: readonly { readonly pipelineId: string }[]
  readonly sources: readonly LoadedModelSource[]
}

/** Today's per-plan compiled model: the converter result plus pipeline identity and inputs. */
export type CompiledBuffer = ConvertedGeneralIbisComponent & {
  name: string
  pipelineId: string
  input: ModelRunDefinition
  sourceEvidence: SourceEvidence
}

/** One `experiments/<id>/native-ibis-assembly.json` entry (and PipelineResult.experiments[].assembly). Key order is serialized. */
export interface AssemblyEntry {
  simulationIbisModelId: string
  definition: IbisModelDefinition
  run: IbisRunConfig
  spicePinMapping: Record<string, string>
  sourceSha256: string | undefined
  spiceSha256: string
  sourceEvidence: SourceEvidence
  metadata: IbisConversionMetadata
  warnings: string[]
}
