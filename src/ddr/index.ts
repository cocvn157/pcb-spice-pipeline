/**
 * ddr — DDR DQ/DQS capture assessment against configured (never inferred) limits.
 * Owns: DdrAssessmentConfig validation, binding configs to experiments/probes/eyes (receiver pads
 * checked against geometry), received-differential-DQS crossing detection, per-capture
 * classification (setup/hold/DC margins), and the assessment status rule. Produces capture times
 * that observation folds on. Writes no artifacts (assessments are embedded in eye-data.json).
 * Imports: kernel, board (types), simulation (plan/probe types). (Was: ddr.ts.)
 */
export type { DdrModeling, DdrAssessmentConfig, ResolvedDdrAssessment, DdrAssessment, DdrCapture, CheckStatus } from './types.js'
export { validateDdrConfig, resolveDdrAssessments, assessDdr } from './assess.js'
