import type { SafeId } from '../kernel/index.js'
/** Strictly increasing finite times (s), equal-length finite volts (V). */
export interface Signal { readonly t: Float64Array; readonly v: Float64Array }
/**
 * Recorded solver rows as probeWaveformRows returns them: [time_s, probe1_v, probe2_v, ...].
 * Column k (1-based) is the k-th declared probe; timestamps are the actual adaptive solver times.
 */
export type WaveformRows = readonly (readonly number[])[]
/** The fields folding reads. `column` is the probe's 1-based column in WaveformRows. */
export interface EyeGate {
  name: string; column: number
  unitIntervalSeconds: number; timeOriginSeconds: number; startTimeSeconds: number; endTimeSeconds: number
}
/** A declared eye (today's plan.eyes entry; key order is serialized into eye-data.json). */
export interface EyeRequest extends EyeGate {
  simulationEyeDiagramId: SafeId; simulationExperimentId: SafeId; simulationVoltageProbeId: SafeId
}
/**
 * stimulus-clock: b_k = timeOrigin + k*UI, window [b_k - UI/2, b_k + 3UI/2].
 * received-differential-dqs: window [c - UI, c + UI] around each supplied capture time (from ddr).
 * Complete windows only, in both cases. `kind` is the serialized `alignment` string.
 */
export type EyeAlignment =
  | { readonly kind: 'stimulus-clock' }
  | { readonly kind: 'received-differential-dqs'; readonly captureTimesSeconds: readonly number[] }
/** Allocation limits checked before any folded sample is produced. */
export interface EyeLimits { maxWindows?: number; maxSamples?: number }
export interface FoldOptions {
  /** Default { kind: 'stimulus-clock' }. */
  alignment?: EyeAlignment
  /** Default 1200. */
  pointsPerWindow?: number
  limits?: EyeLimits
}
/** [window index, folded time offset (s), absolute time (s), voltage (V)]. */
export type EyeSample = [window: number, offsetSeconds: number, timeSeconds: number, voltageV: number]
export interface EyeMetrics {
  kind: 'finite observed voltage eye'
  alignment: EyeAlignment['kind']
  samples: number
  voltageRangeV: [number, number]
  unitIntervalSeconds: number
  timeOriginSeconds: number | null
  measurementStartSeconds: number
  measurementEndSeconds: number
  observedStartSeconds: number
  observedEndSeconds: number
  windows: number
  limitations: string[]
}
/** Today's foldProbeEye return value. */
export interface FoldedEye {
  samples: EyeSample[]
  windows: number
  pointsPerWindow: number
  windowOriginsSeconds: number[]
  boundaryIndices: number[]
  metrics: EyeMetrics
}
/** Today's eye-data.json descriptor (and eyes.json entry). Key order = serialized order. */
export type EyeResult = EyeRequest & {
  readonly samples: EyeSample[]
  readonly alignment: EyeAlignment['kind']
  /** Opaque to observation; ddr's assessment, embedded verbatim when supplied. */
  readonly ddrAssessment?: unknown
  /** Relative to the experiment directory: `eyes/<simulationEyeDiagramId>`. */
  readonly directory: string
  readonly windows: number
  readonly pointsPerWindow: number
  readonly windowOriginsSeconds: number[]
  readonly boundaryIndices: number[]
  readonly interpolation: string
  readonly windowDefinition: string
  readonly source: string
  readonly sourceSha256: string
  readonly metrics: EyeMetrics
}
