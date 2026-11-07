import { diagnostics } from '../kernel'
export const fail = diagnostics('observation', [
  'waveform', 'eye_resolution', 'eye_timing', 'eye_probe', 'eye_windows', 'eye_budget', 'eye_interpolation',
] as const)
