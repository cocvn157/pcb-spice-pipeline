import { ArtifactLedger, type FileMap } from '../kernel'
import type { SolverContext } from '../solver'
import type { PipelineOptions, PipelineResult } from './result'
import { PRE_VALIDATION, type AnyStage, type Phase, type PipelineState, type PureContext, type StateAt } from './state'
import { STAGES } from './stages'

/** Adds the sealed ledger to the sealed state's result. A plain function, not a stage. */
function sealResult(state: StateAt<'sealed'>, files: FileMap): PipelineResult {
  return { ...state.result, files }
}

/**
 * Public. Deterministic fold over STAGES. This is the only place in the pipeline that holds
 * runSolver: pre-validation stages get a PureContext, later ones a SolverContext.
 * On any Diagnostic the run rethrows (no partial result; a rerun recomputes everything).
 * No retries, no caching, no concurrency between experiments.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { runSolver, ...pure } = options
  const progress = pure.onProgress ?? (() => {})
  const pureContext: PureContext = { progress }
  const solverContext: SolverContext = { runSolver, progress }
  let state: PipelineState = { phase: 'input', options: pure }
  let ledger = ArtifactLedger.empty()
  for (const stage of STAGES as readonly AnyStage[]) {
    if (state.phase !== stage.from) throw new Error(`pipeline: stage ${stage.name} expects phase ${stage.from}, got ${state.phase}`)
    const preValidation = (PRE_VALIDATION as readonly Phase[]).includes(stage.from)
    const next: { state: PipelineState; artifacts: Parameters<ArtifactLedger['add']>[0] } = await stage.run(state, preValidation ? pureContext : solverContext)
    ledger = ledger.add(next.artifacts)
    state = next.state
  }
  if (state.phase !== 'sealed') throw new Error(`pipeline: ended in phase ${state.phase}`)
  return sealResult(state, ledger.seal())
}
