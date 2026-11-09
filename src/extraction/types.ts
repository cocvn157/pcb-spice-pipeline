import type { ExtractionSettings } from '../board'
import type { Matrix } from './linalg'
import type { ImpedanceSample } from './parse'
import type { MatrixCheck, CapacitanceCheck } from './checks'

export type { ExtractionSettings, Matrix, ImpedanceSample, MatrixCheck, CapacitanceCheck }
/** extraction's slice of the flat public `Modeling`. */
export interface ExtractionModeling { extraction: ExtractionSettings; sections: number }

export interface RefinementCheck {
  coarseFilaments: number
  refinedFilaments: number
  coarseGroundMeshMm?: number
  refinedGroundMeshMm?: number
  frequencyHz: number
  definition: string
  tolerance: number
  R: number
  L: number
}
/** One stage's checked extraction: today's `stage-N/extraction.json` and one entry of PipelineResult.matrices. Key order is serialized. */
export interface ExtractedStage {
  stage: number; profile: string
  lanes?: string[]; laneIndices?: number[]
  R: Matrix; L: Matrix; C: Matrix
  units: { R: 'ohm'; L: 'H'; C: 'F' }
  frequencyHz: number
  primitiveOrder: string[]
  primitiveImpedance: ImpedanceSample[]
  modelPrimitiveImpedance: ImpedanceSample
  primitiveCapacitance: Matrix
  checks: {
    R: MatrixCheck; L: MatrixCheck; C: CapacitanceCheck; primitiveC: MatrixCheck
    convergence: RefinementCheck; capConvergence: number
    analyticResistanceOhm: number[]; analyticResistanceRelativeErrors: number[]; analyticFrequencyHz: number
    analyticLoopResistanceOhm: Matrix | null; dcLoopResidual: number | null
    energyResidual: number; neutralityResidual: number
  }
  conversions: {
    impedance: string; capacitance: string
    capacitanceSolverCoordinateUnits: 'mm' | 'm'; capacitanceScaleToFarads: number; neutralityDenominatorF: number
  }
}
/** Today's `extracted` array (PipelineResult.matrices), in stage order. */
export type ChannelMatrices = ExtractedStage[]
export interface ExtractedChannel {
  readonly matrices: ChannelMatrices
  /** `channel.cir`: `.subckt CHANNEL IN0.. OUT0.. REF` from channelSpice(matrices, sections). */
  readonly spice: string
}
