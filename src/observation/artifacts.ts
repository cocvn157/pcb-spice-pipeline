import type { Artifact, ArtifactScope, Produced } from '../kernel/index.js'
import { foldProbeEye } from './fold.js'
import type { EyeRequest, EyeResult, EyeSample, WaveformRows } from './types.js'

/** Today's eye-data.csv bytes. */
export function eyeDataCsv(samples: readonly EyeSample[]): string {
  return 'window,folded_time_s,time_s,voltage_v\n' + samples.map(row => row.join(',')).join('\n') + '\n'
}

/** One eye to fold. A DDR assessment (opaque here) comes only with its received capture times. */
export type EyeFoldInput =
  | { readonly request: EyeRequest; readonly alignment: { readonly kind: 'stimulus-clock' } }
  | { readonly request: EyeRequest; readonly alignment: { readonly kind: 'received-differential-dqs'; readonly captureTimesSeconds: readonly number[] }; readonly ddrAssessment: unknown }

/**
 * Fold each eye of one experiment with default resolution/limits and write today's artifacts
 * under `experiment` (the `experiments/<id>` scope): eyes/<eyeId>/eye-data.csv,
 * eyes/<eyeId>/eye-data.json and eyes.json. `waveform.sha256` is the SHA-256 of that
 * experiment's waveform.csv. Bytes match the pre-module general-pipeline.ts eye loop.
 */
export function foldEyes(rows: WaveformRows, eyes: readonly EyeFoldInput[], waveform: { readonly sha256: string }, experiment: ArtifactScope): Produced<EyeResult[]> {
  const artifacts: Artifact[] = [], results: EyeResult[] = []
  for (const input of eyes) {
    const eye = input.request, received = input.alignment.kind === 'received-differential-dqs'
    const ddrAssessment = 'ddrAssessment' in input ? input.ddrAssessment : undefined
    const directory = `eyes/${eye.simulationEyeDiagramId}`, scope = experiment.child('eyes', eye.simulationEyeDiagramId)
    const folded = foldProbeEye(rows, eye, { alignment: input.alignment })
    artifacts.push(scope.text('eye-data.csv', eyeDataCsv(folded.samples)))
    const descriptor: EyeResult = {
      ...eye, samples: folded.samples, alignment: input.alignment.kind, ddrAssessment, directory, windows: folded.windows,
      pointsPerWindow: folded.pointsPerWindow, windowOriginsSeconds: folded.windowOriginsSeconds, boundaryIndices: folded.boundaryIndices,
      interpolation: 'linear interpolation of actual adaptive solver timestamps',
      windowDefinition: received
        ? '[received DQS crossing + sampleOffset - UI, received DQS crossing + sampleOffset + UI]; capture at center; complete windows only'
        : 'b_k=timeOrigin+k*UI; [b_k-UI/2,b_k+3*UI/2]; complete windows only',
      source: '../../waveform.csv', sourceSha256: waveform.sha256, metrics: folded.metrics,
    }
    artifacts.push(scope.json('eye-data.json', descriptor)); results.push(descriptor)
  }
  artifacts.push(experiment.json('eyes.json', results))
  return { value: results, artifacts }
}
