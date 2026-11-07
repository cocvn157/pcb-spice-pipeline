import { diagnostics } from '../kernel/index.js'
export const fail = diagnostics('report', ['report_missing_artifact'] as const)
