// Test helper: today's runPipeline order composed by hand from the new modules (board, buffers, simulation,
// extraction, ddr, observation), without the pipeline module. Exercises runExperiment's acceptance rules.
import { ArtifactLedger, rootScope } from '../../src/kernel'
import type { RunSolver } from '../../src/solver'
import { geometryFromCircuitJson, validateCircuitRecords, type CircuitJson, type Modeling as BoardModeling } from '../../src/board'
import { extractChannel, type ExtractionModeling } from '../../src/extraction'
import { foldEyes, type EyeFoldInput } from '../../src/observation'
import { assertConverter, admitBuffers, compileBuffers, ibisAssembly, type BufferModeling, type IbisSources } from '../../src/buffers'
import {
  generalDeclarations, electricalSources, safeSimulationPlans, modelRunDefinition, bindExperiments, electricalNodeMap,
  runExperiment, simulationResultCircuitJson, experimentResult, type ExperimentRun, type SimulationModeling,
} from '../../src/simulation'
import { resolveDdrAssessments, assessDdr, type DdrModeling } from '../../src/ddr'

export type ComposedModeling = BoardModeling & ExtractionModeling & SimulationModeling & DdrModeling & BufferModeling
export interface ComposeInput { circuitJson: CircuitJson; modeling: ComposedModeling; ibisSources: IbisSources; runSolver: RunSolver; onProgress?: (m: string) => void }

export async function compose({ circuitJson, modeling, ibisSources, runSolver, onProgress = () => {} }: ComposeInput) {
  validateCircuitRecords(circuitJson)
  assertConverter()
  const geometry = geometryFromCircuitJson(circuitJson, modeling), declarations = generalDeclarations(circuitJson, geometry, modeling)
  const ddrAssessments = resolveDdrAssessments(declarations.plans, geometry, modeling.ddrAssessments)
  const electrical = electricalSources(circuitJson, modeling, declarations.nodes)
  const plans = safeSimulationPlans(declarations.plans)
  const admitted = admitBuffers(declarations.models, ibisSources, modeling, rootScope('buffers'))
  const compiled = compileBuffers(admitted.value, declarations.plans, modelRunDefinition)
  const bound = bindExperiments({ ...declarations, electrical }, geometry, compiled)
  // ---- validation line: no solver work above ----
  let ledger = ArtifactLedger.empty().add(admitted.artifacts).add([
    rootScope('pipeline').json('inputs/modeling.json', modeling), rootScope('board').json('inputs/circuit.json', circuitJson),
    rootScope('board').json('geometry.json', geometry), electricalNodeMap(declarations.nodes, electrical, rootScope('simulation')),
  ])
  const ctx = { runSolver, progress: onProgress }
  const extracted = await extractChannel(geometry, modeling, rootScope('extraction'), ctx)
  ledger = ledger.add(extracted.artifacts)
  const runs: ExperimentRun[] = [], experiments = []
  for (const [index, plan] of plans.entries()) {
    const scope = rootScope('simulation').child('experiments', plan.simulationExperimentId)
    const assembly = ibisAssembly(compiled[index], scope.handTo('buffers'))
    ledger = ledger.add(assembly.artifacts)
    const run = await runExperiment(ctx, scope, bound, index, geometry, modeling, extracted.value.matrices)
    ledger = ledger.add(run.artifacts); runs.push(run.value)
    const inputs: EyeFoldInput[] = plan.eyes.map(eye => {
      const assessment = ddrAssessments.find(a => a.eye === eye), ddrAssessment = assessment ? assessDdr(run.value.rows, assessment) : undefined
      return ddrAssessment ? { request: eye, alignment: { kind: 'received-differential-dqs', captureTimesSeconds: ddrAssessment.captureTimesSeconds }, ddrAssessment } : { request: eye, alignment: { kind: 'stimulus-clock' } }
    })
    const eyes = foldEyes(run.value.rows, inputs, { sha256: run.value.waveformCsvSha256 }, scope.handTo('observation'))
    ledger = ledger.add(eyes.artifacts)
    experiments.push(experimentResult(run.value, eyes.value, assembly.value))
  }
  const results = simulationResultCircuitJson(circuitJson, declarations.plans, runs)
  ledger = ledger.add([rootScope('simulation').json('circuit-results.json', results)])
  const limitations = [...geometry.approximations, ...compiled.flatMap(models => models.flatMap(model => model.warnings ?? [])),
    'Only selected channel components/passives and explicit ideal source rails are simulated; unrelated board electronics excluded',
    'Finite observed transient eyes; no implicit traffic, random jitter, BER extrapolation, protocol compliance or hardware accuracy claim',
    'Maximum solver integration step and display resolution are separate settings']
  return { circuitJson, simulationResultCircuitJson: results, modeling, geometry, matrices: extracted.value.matrices, experiments, limitations, files: ledger.seal() }
}
