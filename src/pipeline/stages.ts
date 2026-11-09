import { rootScope, type Artifact } from '../kernel'
import { admitBoard, channelGeometry, circuitArtifact } from '../board'
import { extractChannel } from '../extraction'
import { assertConverter, admitBuffers, compileBuffers, ibisAssembly } from '../buffers'
import {
  generalDeclarations, electricalSources, safeSimulationPlans, modelRunDefinition, bindExperiments, electricalNodeMap,
  runExperiment, simulationResultCircuitJson, experimentResult,
} from '../simulation'
import { foldEyes, type EyeFoldInput } from '../observation'
import { resolveDdrAssessments, assessDdr } from '../ddr'
import { modelingFromCircuitJson } from './modeling'
import type { EyeDescriptor } from './result'
import type { Chain, ObservedRun, Stage } from './state'

/**
 * The one list of stages. Order here IS execution order, and it is today's runPipeline order
 * (same failure order, same progress messages, same artifact bytes):
 *   admit    input→admitted      modeling (given ?? modelingFromCircuitJson); board.admitBoard; buffers.assertConverter
 *   declare  admitted→declared   board.channelGeometry; simulation.generalDeclarations; ddr.resolveDdrAssessments;
 *                                simulation.electricalSources + safeSimulationPlans; buffers.admitBuffers
 *   bind     declared→bound      buffers.compileBuffers; simulation.bindExperiments      ── validation line
 *   extract  bound→extracted     extraction.extractChannel                (first solver use)
 *   simulate extracted→simulated per experiment, in order: buffers.ibisAssembly; simulation.runExperiment;
 *                                then that run's eyes (ddr.assessDdr -> observation.foldEyes) before the next
 *                                experiment's solver work, so an eye failure stops the run exactly where it did
 *   observe  simulated→observed  simulation.experimentResult per run; simulation.simulationResultCircuitJson
 *   seal     observed→sealed     circuit-results.json; limitations (the ledger itself is sealed in run.ts)
 */
export const admit: Stage<'input', 'admitted'> = {
  name: 'admit', from: 'input', to: 'admitted',
  run: ({ options }) => {
    const modeling = options.modeling ?? modelingFromCircuitJson(options.circuitJson)
    const board = admitBoard(options.circuitJson)
    assertConverter()
    return {
      state: { phase: 'admitted', options, board, modeling },
      artifacts: [rootScope('pipeline').child('inputs').json('modeling.json', modeling), circuitArtifact(board, rootScope('board'))],
    }
  },
}

export const declare: Stage<'admitted', 'declared'> = {
  name: 'declare', from: 'admitted', to: 'declared',
  run: state => {
    const { board, modeling, options } = state
    const geometry = channelGeometry(board, modeling, rootScope('board'))
    const declarations = generalDeclarations(board.circuitJson, geometry.value, modeling)
    const ddr = resolveDdrAssessments(declarations.plans, geometry.value, modeling.ddrAssessments)
    const electrical = electricalSources(board.circuitJson, modeling, declarations.nodes)
    const plans = safeSimulationPlans(declarations.plans)
    const buffers = admitBuffers(declarations.models, options.ibisSources, modeling, rootScope('buffers'))
    return {
      state: { ...state, phase: 'declared', geometry: geometry.value, experiments: { ...declarations, electrical }, plans, ddr, buffers: buffers.value },
      artifacts: [...buffers.artifacts, ...geometry.artifacts, electricalNodeMap(declarations.nodes, electrical, rootScope('simulation'))],
    }
  },
}

export const bind: Stage<'declared', 'bound'> = {
  name: 'bind', from: 'declared', to: 'bound',
  run: state => {
    const compiled = compileBuffers(state.buffers, state.experiments.plans, modelRunDefinition, state.board.circuitJson)
    const bound = bindExperiments(state.experiments, state.geometry, compiled)
    return { state: { ...state, phase: 'bound', compiled, bound }, artifacts: [] }
  },
}

export const extract: Stage<'bound', 'extracted'> = {
  name: 'extract', from: 'bound', to: 'extracted',
  run: async (state, ctx) => {
    const channel = await extractChannel(state.geometry, state.modeling, rootScope('extraction'), ctx)
    return { state: { ...state, phase: 'extracted', channel: channel.value }, artifacts: channel.artifacts }
  },
}

export const simulate: Stage<'extracted', 'simulated'> = {
  name: 'simulate', from: 'extracted', to: 'simulated',
  run: async (state, ctx) => {
    const runs: ObservedRun[] = []
    const artifacts: Artifact[] = []
    for (const [index, plan] of state.plans.entries()) {
      const scope = rootScope('simulation').child('experiments', plan.simulationExperimentId)
      const assembly = ibisAssembly(state.compiled[index], scope.handTo('buffers'))
      const run = await runExperiment(ctx, scope, state.bound, index, state.geometry, state.modeling, state.channel.matrices)
      const inputs: EyeFoldInput[] = plan.eyes.map(eye => {
        const assessment = state.ddr.find(a => a.eye === eye)
        const ddrAssessment = assessment ? assessDdr(run.value.rows, assessment) : undefined
        return ddrAssessment
          ? { request: eye, alignment: { kind: 'received-differential-dqs', captureTimesSeconds: ddrAssessment.captureTimesSeconds }, ddrAssessment }
          : { request: eye, alignment: { kind: 'stimulus-clock' } }
      })
      const eyes = foldEyes(run.value.rows, inputs, { sha256: run.value.waveformCsvSha256 }, scope.handTo('observation'))
      artifacts.push(...assembly.artifacts, ...run.artifacts, ...eyes.artifacts)
      runs.push({ run: run.value, eyes: eyes.value as EyeDescriptor[], assembly: assembly.value })
    }
    return { state: { ...state, phase: 'simulated', runs }, artifacts }
  },
}

export const observe: Stage<'simulated', 'observed'> = {
  name: 'observe', from: 'simulated', to: 'observed',
  run: state => {
    const experimentResults = state.runs.map(({ run, eyes, assembly }) => experimentResult(run, eyes, assembly))
    const results = simulationResultCircuitJson(state.board.circuitJson, state.experiments.plans, state.runs.map(r => r.run))
    return { state: { ...state, phase: 'observed', experimentResults, results }, artifacts: [] }
  },
}

export const seal: Stage<'observed', 'sealed'> = {
  name: 'seal', from: 'observed', to: 'sealed',
  run: state => {
    const limitations = [...state.geometry.approximations, ...state.compiled.flatMap(models => models.flatMap(model => model.warnings ?? [])),
      'Only selected channel components/passives and explicit ideal source rails are simulated; unrelated board electronics excluded',
      'Finite observed transient eyes; no implicit traffic, random jitter, BER extrapolation, protocol compliance or hardware accuracy claim',
      'Maximum solver integration step and display resolution are separate settings']
    return {
      state: { phase: 'sealed', result: {
        circuitJson: state.options.circuitJson, simulationResultCircuitJson: state.results, modeling: state.modeling,
        geometry: state.geometry, matrices: state.channel.matrices, experiments: state.experimentResults, limitations,
      } },
      artifacts: [rootScope('simulation').json('circuit-results.json', state.results)],
    }
  },
}

const stages = [admit, declare, bind, extract, simulate, observe, seal] as const
/** Compile error if a stage is missing, duplicated or out of order. */
export const STAGES: Chain<typeof stages> = stages
