import type { Artifact } from '../kernel'
import type { SolverContext } from '../solver'
import type { Board, ChannelGeometry, CircuitJson } from '../board'
import type { ExtractedChannel } from '../extraction'
import type { AdmittedBuffers, AssemblyEntry, CompiledBuffer } from '../buffers'
import type { Experiments, BoundExperiments, ExperimentRun, SafeSimulationPlan } from '../simulation'
import type { ResolvedDdrAssessment } from '../ddr'
import type { PipelineModeling } from './modeling'
import type { EyeDescriptor, ExperimentResult, PipelineOptions, PipelineResult } from './result'

/**
 * Pipeline state is a discriminated union; each phase carries everything earlier phases
 * produced. A stage can only read what the phase guarantees exists.
 */
/** runSolver is stripped here; only run.ts holds it and hands it out via SolverContext. */
export type PureOptions = Omit<PipelineOptions, 'runSolver'>
type Input     = { phase: 'input'; options: PureOptions }
type Admitted  = { phase: 'admitted'; board: Board; modeling: PipelineModeling } & Omit<Input, 'phase'>
type Declared  = { phase: 'declared'; geometry: ChannelGeometry; experiments: Experiments; plans: readonly SafeSimulationPlan[];
                   ddr: readonly ResolvedDdrAssessment[]; buffers: AdmittedBuffers } & Omit<Admitted, 'phase'>
/** The validation line: everything checkable without a solver has been checked. */
type Bound     = { phase: 'bound'; compiled: CompiledBuffer[][]; bound: BoundExperiments<CompiledBuffer> } & Omit<Declared, 'phase'>
type Extracted = { phase: 'extracted'; channel: ExtractedChannel } & Omit<Bound, 'phase'>
/** One experiment's accepted ngspice run, its folded eyes and its IBIS assembly evidence. */
export interface ObservedRun { readonly run: ExperimentRun; readonly eyes: EyeDescriptor[]; readonly assembly: AssemblyEntry[] }
type Simulated = { phase: 'simulated'; runs: readonly ObservedRun[] } & Omit<Extracted, 'phase'>
type Observed  = { phase: 'observed'; experimentResults: ExperimentResult[]; results: CircuitJson } & Omit<Simulated, 'phase'>
/** Everything but `files`: run.ts seals the ledger and adds them (sealResult). */
type Sealed    = { phase: 'sealed'; result: Omit<PipelineResult, 'files'> }

export type PipelineState = Input | Admitted | Declared | Bound | Extracted | Simulated | Observed | Sealed
export type Phase = PipelineState['phase']
export type StateAt<P extends Phase> = Extract<PipelineState, { phase: P }>

/** Before the validation line a stage gets no RunSolver at all — enforced by type, not review. */
export type PreValidation = 'input' | 'admitted' | 'declared'
export const PRE_VALIDATION: readonly PreValidation[] = ['input', 'admitted', 'declared']
export interface PureContext { readonly progress: (m: string) => void }
export type ContextFor<P extends Phase> = P extends PreValidation ? PureContext : SolverContext

export interface Advance<To extends Phase> { readonly state: StateAt<To>; readonly artifacts: readonly Artifact[] }

/** A stage is a value: name, typed edge, and a run function. */
export interface Stage<From extends Phase = Phase, To extends Phase = Phase> {
  readonly name: string
  readonly from: From
  readonly to: To
  run(state: StateAt<From>, ctx: ContextFor<From>): Advance<To> | Promise<Advance<To>>
}

/** Type-level proof that a tuple of stages is a contiguous chain from 'input' to 'sealed'. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Stage is invariant in From/To; `any` only for the tuple constraint
export type AnyStage = Stage<any, any>
export type Chain<S extends readonly AnyStage[], Expect extends Phase = 'input'> =
  S extends readonly [infer H extends AnyStage, ...infer R extends readonly AnyStage[]]
    ? [H['from']] extends [Expect]
      ? R extends readonly []
        ? ([H['to']] extends ['sealed'] ? S : never)
        : (Chain<R, H['to']> extends never ? never : S)
      : never
    : never
