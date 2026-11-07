import type { FileMap } from '../kernel/index.js'
import type { CircuitJson, ChannelGeometry } from '../board/index.js'
import type { ChannelMatrices } from '../extraction/index.js'
import type { RunSolver } from '../solver/index.js'
import type { IbisSources, AssemblyEntry } from '../buffers/index.js'
import type { SimulationPlan, VoltageProbePlan } from '../simulation/index.js'
import type { EyeResult } from '../observation/index.js'
import type { DdrAssessment } from '../ddr/index.js'
import type { PipelineModeling } from './modeling.js'

export interface PipelineOptions {
  circuitJson: CircuitJson
  modeling?: PipelineModeling
  ibisSources: IbisSources
  runSolver: RunSolver
  onProgress?: (message: string) => void
}

/**
 * One `experiments/<id>/eyes/<eyeId>/eye-data.json` descriptor (and `eyes.json` entry): observation's
 * EyeResult with ddr's assessment embedded when the eye is DDR-aligned. Its CSV lives at
 * `${experiment.directory}/${eye.directory}/eye-data.csv` in PipelineResult.files.
 */
export interface EyeDescriptor extends EyeResult {
  readonly ddrAssessment?: DdrAssessment
}

/** One PipelineResult.experiments[] entry. Field set and serialized key order are today's. */
export interface ExperimentResult {
  plan: SimulationPlan
  waveform: { timeUnit: 's'; voltageUnit: 'V'; rows: number[][] }
  simulationExperimentId: string
  name: string
  /** `experiments/<simulationExperimentId>`. */
  directory: string
  durationSeconds: number
  startTimeSeconds: number
  maxStepSeconds: number
  probes: VoltageProbePlan[]
  eyes: EyeDescriptor[]
  solverInvocations: 1
  waveformSamples: number
  assembly: AssemblyEntry[]
  /** `experiments/<id>/native-ibis-assembly.json`. */
  assemblyFile: string
}

/** Designed explicitly (was Awaited<ReturnType<typeof runPipeline>>). Same field names, order and shapes as today. */
export interface PipelineResult {
  circuitJson: CircuitJson
  simulationResultCircuitJson: CircuitJson
  modeling: PipelineModeling
  geometry: ChannelGeometry
  matrices: ChannelMatrices
  experiments: ExperimentResult[]
  limitations: string[]
  /** Sealed ledger: sorted keys, byte-identical for identical inputs + solver outputs. */
  files: FileMap
}
