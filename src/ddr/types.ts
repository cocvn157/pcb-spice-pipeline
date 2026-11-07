// Today's ddr.ts types. DdrAssessment is embedded verbatim in eye-data.json: do not reorder or rename.
import type { EyePlan, VoltageProbePlan } from '../simulation'

/** All voltages are relative to the DQ probe's ground; no datasheet limits are inferred. */
export interface DdrAssessmentConfig {
  name: string
  dataProbe: string
  strobeProbe: string
  experimentNames?: string[]
  direction: 'read' | 'write'
  sampleOffsetSeconds: number
  vrefV: number
  thresholds: { vilAcV: number; vilDcV: number; vihDcV: number; vihAcV: number }
  setupSeconds: number
  holdSeconds: number
  minimumStrobeDifferentialV: number
  maximumStrobeIntervalErrorSeconds: number
  /** A citation alone is insufficient: document the applicable receiver, corner and derating. */
  characterization?: {
    source: string
    receiver: string
    speedGrade: string
    conditions: string
    derating: string
    referencePlane: 'receiver-pad'
  }
}
export interface ResolvedDdrAssessment {
  config: DdrAssessmentConfig
  eye: EyePlan
  data: VoltageProbePlan
  strobe: VoltageProbePlan
}
export type CheckStatus = 'within-configured-limits' | 'violated' | 'not-evaluated'
export interface DdrCapture {
  strobeTimeSeconds: number
  sampleTimeSeconds: number
  rising: boolean
  voltageV: number | null
  level: 'high' | 'low' | 'indeterminate'
  status: CheckStatus
  setupSeconds?: number
  holdSeconds?: number
  setupMarginSeconds?: number
  holdMarginSeconds?: number
  dcMarginV?: number
  setupIsLowerBound?: boolean
  holdIsLowerBound?: boolean
  reason?: string
}
export interface DdrAssessment {
  name: string
  status: 'illustrative' | 'within-characterized-limits' | 'violated' | 'not-evaluated'
  checks: { status: CheckStatus; captures: number; violations: number; unevaluated: number }
  compliance: { status: 'not-evaluated'; reason: string }
  config: DdrAssessmentConfig
  dataProbe: string
  strobeProbe: string
  alignment: 'received-differential-dqs'
  strobe: { status: CheckStatus; crossingsSeconds: number[]; reason?: string }
  captureTimesSeconds: number[]
  captures: DdrCapture[]
  reasons: string[]
  limitations: string[]
}
/** ddr's slice of the flat public `Modeling`. */
export interface DdrModeling { ddrAssessments?: DdrAssessmentConfig[] }
