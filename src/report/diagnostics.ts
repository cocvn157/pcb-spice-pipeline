import { diagnostics } from '../kernel'
export const fail = diagnostics('report', ['report_missing_artifact'] as const)
