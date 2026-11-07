// The per-experiment ngspice part of general-pipeline.ts runPipeline, plus the plan-level checks
// it performed around declarations. Messages, artifact paths and bytes unchanged.
import { safeId, sha256, type Artifact, type ArtifactScope, type Produced } from '../kernel'
import { invoke, type SolverContext } from '../solver'
import { parseRecord, type CircuitJson, type Geometry } from '../board'
import { probeWaveformRows } from '../observation'
import type { StageMatrices } from '../extraction'
import { fail } from './diagnostics'
import { generalSimulationSpice, validateProbeScope } from './netlist'
import type { BoundExperiments, CircuitNodes, ElectricalSources, ExperimentModel, ExperimentResult, ExperimentRun, Experiments, SafeSimulationPlan, SimulationPlan } from './types'

/**
 * Today's runPipeline safeId loop over experiment and eye ids (fails kernel 'simulation_id').
 * Returns the SAME array (no copies: ddr binds eyes by identity), typed with branded ids.
 */
export function safeSimulationPlans(plans: SimulationPlan[]): SafeSimulationPlan[] {
  for (const plan of plans) {
    safeId(plan.simulationExperimentId, 'simulationExperimentId')
    for (const eye of plan.eyes) safeId(eye.simulationEyeDiagramId, 'simulationEyeDiagramId')
  }
  return plans as unknown as SafeSimulationPlan[]
}

/** electrical-node-map.json, written under `scope` (the output root). */
export function electricalNodeMap(nodes: CircuitNodes, electrical: ElectricalSources, scope: ArtifactScope): Artifact {
  return scope.json('electrical-node-map.json', { nodes: nodes.mapping, channelReferenceSourcePortId: nodes.groundSourcePortId, scope: electrical.scope })
}

/** Validate every plan's probe scope against its compiled models (today's preflight before any file or solver work). */
export function bindExperiments<M extends ExperimentModel>(experiments: Experiments, geometry: Pick<Geometry, 'mappings'>, compiled: readonly (readonly M[])[]): BoundExperiments<M> {
  for (const [i, plan] of experiments.plans.entries()) validateProbeScope(plan, geometry, compiled[i], experiments.nodes, experiments.electrical)
  return { ...experiments, compiled } as unknown as BoundExperiments<M>
}

/**
 * Run plans[index] in ngspice under `experiment` (experiments/<id>). Artifacts: experiment.json,
 * the solver's <pipelineId>.lib / simulation.cir / waveform.dat / ngspice.{stdout,stderr}.log /
 * ngspice.request.json, waveform.csv, waveform.json.
 * ngspice can recover a singular operating point through gmin/source stepping; those warnings are
 * accepted only when a complete finite transient follows.
 */
export async function runExperiment(ctx: SolverContext, experiment: ArtifactScope, bound: BoundExperiments, index: number,
  geometry: Pick<Geometry, 'mappings'>, modeling: { sections: number }, extracted: readonly StageMatrices[]): Promise<Produced<ExperimentRun>> {
  const plan = bound.plans[index]
  const models = bound.compiled[index]
  const artifacts: Artifact[] = []
  const solverFiles: Record<string, string> = Object.create(null)
  for (const model of models) solverFiles[`${safeId(model.pipelineId, 'simulationIbisModelId')}.lib`] = model.source
  artifacts.push(experiment.json('experiment.json', plan))
  solverFiles['simulation.cir'] = generalSimulationSpice(plan, geometry, modeling, extracted, models, bound.nodes, bound.electrical)
  ctx.progress(`Simulate ${plan.name} (${plan.probes.length} probes, ${plan.eyes.length} eyes)`)
  const solve = await invoke(ctx, experiment, { solver: 'ngspice', files: solverFiles, args: ['-n', '-b', 'simulation.cir'], outputFiles: ['waveform.dat'] })
  const run = solve.value
  const diagnostic = (run.stdout + '\n' + run.stderr).split(/\r?\n/).find(line => /\b(?:error|fatal|aborted|timestep too small)\b/i.test(line))
  if (diagnostic) fail('native_solver', `${plan.name}: ${diagnostic.trim()}`, { subjects: [{ kind: 'experiment', id: plan.simulationExperimentId }], artifacts: run.logPaths })
  artifacts.push(...solve.artifacts)
  const waveformText = run.outputs['waveform.dat']
  const rows: number[][] = probeWaveformRows(waveformText, plan.probes)
  if (rows[0][0] > plan.startTimeSeconds + Math.max(plan.maxStepSeconds, plan.durationSeconds * 1e-8)) fail('simulation_start', `${plan.name}: solver output omits the beginning of the declared recording`)
  if (Math.abs(rows[rows.length - 1][0] - plan.durationSeconds) > plan.durationSeconds * 1e-8) fail('simulation_duration', `${plan.name}: native solver did not complete the declared duration`)
  const csv = 'time_s,' + plan.probes.map(probe => probe.simulationVoltageProbeId + '_v').join(',') + '\n' + rows.map(row => row.join(',')).join('\n') + '\n'
  artifacts.push(experiment.text('waveform.csv', csv))
  artifacts.push(experiment.json('waveform.json', { simulationExperimentId: plan.simulationExperimentId, probes: plan.probes, samples: rows.length, timestamps: 'actual adaptive solver times in seconds', source: 'waveform.dat', sourceSha256: sha256(waveformText) }))
  const records: CircuitJson = plan.probes.map(probe => parseRecord({ type: 'simulation_transient_voltage_graph', simulation_transient_voltage_graph_id: `simulation_transient_voltage_graph_${plan.simulationExperimentId}_${probe.column}`, simulation_experiment_id: plan.simulationExperimentId, simulation_voltage_probe_id: probe.simulationVoltageProbeId, timestamps_ms: rows.map(row => row[0] * 1000), voltage_levels: rows.map(row => row[probe.column]), time_per_step: plan.maxStepSeconds * 1000, start_time_ms: rows[0][0] * 1000, end_time_ms: rows[rows.length - 1][0] * 1000, name: probe.name }))
  return { value: { plan, directory: experiment.prefix, rows, waveformCsvSha256: sha256(csv), records }, artifacts }
}

/**
 * circuit-results.json content: the input with this backend's prior transient graphs removed, then
 * each run's records in plan order. Fails 'result_schema' if the installed schema dropped probe ids.
 */
export function simulationResultCircuitJson(circuitJson: CircuitJson, plans: readonly SimulationPlan[], runs: readonly ExperimentRun[]): CircuitJson {
  const pcbExperimentIds = new Set(plans.map(plan => plan.simulationExperimentId))
  const results: CircuitJson = circuitJson.filter(record => record.type !== 'simulation_transient_voltage_graph' || !pcbExperimentIds.has(record.simulation_experiment_id))
  for (const run of runs) results.push(...run.records)
  for (const graph of results.filter(record => record.type === 'simulation_transient_voltage_graph')) if (pcbExperimentIds.has(graph.simulation_experiment_id) && !graph.simulation_voltage_probe_id) fail('result_schema', 'Installed Circuit JSON schema discarded the result probe ID')
  return results
}

/** Today's PipelineResult.experiments[] entry for one run. */
export function experimentResult<E, A>(run: ExperimentRun, eyes: E[], assembly: A[]): ExperimentResult<E, A> {
  const { plan, directory: relative, rows } = run
  return { plan, waveform: { timeUnit: 's', voltageUnit: 'V', rows }, simulationExperimentId: plan.simulationExperimentId, name: plan.name, directory: relative, durationSeconds: plan.durationSeconds, startTimeSeconds: plan.startTimeSeconds, maxStepSeconds: plan.maxStepSeconds, probes: plan.probes, eyes, solverInvocations: 1, waveformSamples: rows.length, assembly, assemblyFile: relative + '/native-ibis-assembly.json' }
}
