/**
 * simulation — experiments as declared on the board, and running them in ngspice.
 * Owns: SimulationPlan declaration from simulation_* records (timing, probes, stimuli, pin
 * states, eye requests), electrical node mapping + ideal sources/passives, the converter run
 * definition per model, probe-scope validation, the experiment netlist, ngspice diagnostics,
 * waveform coverage checks, and simulation_transient_voltage_graph result records.
 * Order (today's runPipeline): generalDeclarations -> electricalSources -> safeSimulationPlans
 * -> [buffers compile with modelRunDefinition] -> bindExperiments -> [extraction] -> runExperiment per plan.
 * Artifacts: electrical-node-map.json, experiments/<id>/{experiment.json, <model>.lib, simulation.cir,
 * ngspice.*, waveform.dat, waveform.csv, waveform.json}.
 * Imports: kernel, solver, board, extraction, observation, buffers (types).
 * (Was: declarations.ts, general-spice.ts, stimulus.ts, ngspice part of general-pipeline.ts.)
 */
export type {
  SimulationModeling, CircuitNodes, PipelineIbisModel, VoltageProbePlan, EyePlan, SimulationPlan, SafeEyePlan, SafeSimulationPlan,
  Declarations, ElectricalModel, CompiledModel, ExperimentModel, ElectricalSources, SimulationSpiceOptions,
  Experiments, BoundExperiments, ExperimentRun, ExperimentResult,
} from './types.js'
export { circuitNodes, generalDeclarations, modelRunDefinition } from './declarations.js'
export { namespaceSpice, electricalSources, simulationSpiceOptions, generalSimulationSpice, validateProbeScope } from './netlist.js'
export { safeSimulationPlans, electricalNodeMap, bindExperiments, runExperiment, simulationResultCircuitJson, experimentResult } from './run.js'
export { transmittedBits } from './stimulus.js'
