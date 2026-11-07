// Was src/general-spice.ts (electrical sources, experiment netlist, probe scope). Logic and messages unchanged.
import type { CircuitJson, Geometry } from '../board'
import { selectPort } from '../board'
import { channelSpice, type StageMatrices } from '../extraction'
import { fail } from './diagnostics'
import type { CircuitNodes, CompiledModel, ElectricalModel, ElectricalSources, SimulationModeling, SimulationPlan, SimulationSpiceOptions } from './types'

/** Formats a number with 17 significant digits so SPICE decks round-trip doubles exactly. */
const num = (value: number): string => Number(value.toPrecision(17)).toString()
/** Rejects any electrical input that is not a finite number (or not positive, when required) before it reaches the deck. */
const finite = (input: unknown, label: string, positive: boolean = false): number => {
  if (typeof input !== 'number' || !Number.isFinite(input) || (positive && input <= 0)) return fail('electrical_input', `${label}: explicit finite ${positive ? 'positive ' : ''}value required`)
  return input
}
/** Checks an electrical input and formats it for the deck in one step. */
const value = (input: unknown, label: string, positive: boolean = false): string => num(finite(input, label, positive))
/** Flattens a name onto one line so it cannot break out of a SPICE comment. */
const safeComment = (text: string): string => text.replace(/[\r\n]/g, ' ')

/**
 * Prefixes every subcircuit name in a converter library so several IBIS models can share one deck.
 * Also returns the prefixed name of the top-level wrapper to instantiate.
 */
export function namespaceSpice(source: string, prefix: string): { source: string; wrapper: string } {
  const names = [...source.matchAll(/^\.subckt\s+(\S+)/gmi)].map(match => match[1])
  if (!names.length) fail('ibis_contract', 'Converter did not emit a SPICE component wrapper')
  const renamed = new Map(names.map(name => [name.toLowerCase(), `${prefix}_${name}`]))
  return { source: source.replace(/\S+/g, token => renamed.get(token.toLowerCase()) ?? token), wrapper: `${prefix}_${names[0]}` }
}

/**
 * Turns physical voltage sources, declared supplies and selected passives into SPICE lines.
 * Fails when a source is shorted, floating or unsupported, because this backend never invents rails.
 */
export function electricalSources(circuit: CircuitJson, modeling: SimulationModeling, nodes: CircuitNodes): ElectricalSources {
  const sources: string[] = []
  const passives: string[] = []
  const activeNodes = new Set(['0'])
  const dcConnections: Array<[string, string]> = []
  const sourceBindings: ElectricalSources['sourceBindings'] = []
  const sourcePorts = circuit.filter(e => e.type === 'source_port')
  const sourceComponents = circuit.filter(e => e.type === 'source_component')
  /** Marks both nodes as part of the modeled circuit and returns them as a SPICE terminal pair. */
  const terminals = (positive: string, negative: string): string => {
    activeNodes.add(positive)
    activeNodes.add(negative)
    return `${positive} ${negative}`
  }
  for (const [i, source] of circuit.filter(e => e.type === 'simulation_voltage_source').entries()) {
    const positive = source.is_dc_source ? source.positive_source_port_id ?? source.positive_source_net_id : source.terminal1_source_port_id
    const negative = source.is_dc_source ? source.negative_source_port_id ?? source.negative_source_net_id : source.terminal2_source_port_id
    if (!positive || !negative) return fail('supply_reference', 'Voltage sources require explicit positive and negative source port/net terminals')
    const pos = nodes.node(positive)
    const neg = nodes.node(negative)
    if (pos === neg) fail('supply_short', 'Voltage source terminals resolve to the same node')
    let expression: string
    if (source.is_dc_source || !source.wave_shape) expression = value(source.voltage, 'voltage source voltage')
    else if (source.wave_shape === 'square') {
      const period = source.period === undefined ? 1 / finite(source.frequency, 'source frequency', true) : source.period / 1000
      const amplitude = finite(source.peak_to_peak_voltage ?? source.voltage, 'source amplitude')
      const low = source.peak_to_peak_voltage === undefined ? 0 : finite(source.voltage, 'source offset') - amplitude / 2
      const high = low + amplitude
      const rise = (source.rise_time ?? 0) / 1000
      const fall = (source.fall_time ?? 0) / 1000
      if (rise <= 0 || fall <= 0) fail('source_edge', 'Square voltage sources require explicit positive rise/fall times')
      expression = `PULSE(${value(low, 'source low')} ${value(high, 'source high')} ${value((source.pulse_delay ?? 0) / 1000, 'source delay')} ${value(rise, 'source rise', true)} ${value(fall, 'source fall', true)} ${value(source.pulse_width === undefined ? period * (source.duty_cycle ?? .5) : source.pulse_width / 1000, 'source width', true)} ${value(period, 'source period', true)})`
    } else return fail('source_capability', `Voltage waveform ${source.wave_shape} is unsupported by this PCB backend`)
    sources.push(`VPHYSICAL${i} ${terminals(pos, neg)} ${expression}`)
    const port = sourcePorts.find(e => e.source_port_id === positive)
    const component = sourceComponents.find(e => e.source_component_id === port?.source_component_id)
    sourceBindings.push({ name: component?.name ?? source.simulation_voltage_source_id, positiveNode: pos, negativeNode: neg })
    dcConnections.push([pos, neg])
  }
  for (const [i, source] of (modeling.supplies ?? []).entries()) {
    const pos = nodes.node(selectPort(circuit, source.positive).source_port_id)
    const neg = nodes.node(selectPort(circuit, source.negative).source_port_id)
    if (pos === neg) fail('supply_short', 'Explicit supply terminals resolve to the same node')
    sources.push(`VDECLARED${i} ${terminals(pos, neg)} ${value(source.voltageV, 'declared supply')}`)
    sourceBindings.push({ name: `modeling.supplies[${i}]`, positiveNode: pos, negativeNode: neg })
    dcConnections.push([pos, neg])
  }
  for (const [i, selection] of (modeling.passiveComponents ?? []).entries()) {
    const components = sourceComponents.filter(e => selection.sourceComponentId ? e.source_component_id === selection.sourceComponentId : e.name === selection.component)
    if (components.length !== 1) fail('passive_reference', 'Selected passive component is missing or ambiguous')
    const component = components[0]
    const ports = sourcePorts.filter(e => e.source_component_id === component.source_component_id).sort((a, b) => Number(a.pin_number) - Number(b.pin_number))
    if (ports.length !== 2) fail('passive_capability', `${component.name}: expected two physical ports`)
    const pos = nodes.node(ports[0].source_port_id)
    const neg = nodes.node(ports[1].source_port_id)
    let kind: 'R' | 'C' | 'L'
    let amount: unknown
    let quantity: string
    switch (component.ftype) {
      case 'simple_resistor': kind = 'R'
      amount = component.resistance
      quantity = 'resistance'
      break
      case 'simple_capacitor': kind = 'C'
      amount = component.capacitance
      quantity = 'capacitance'
      break
      case 'simple_inductor': kind = 'L'
      amount = component.inductance
      quantity = 'inductance'
      break
      default: return fail('passive_capability', `${component.name}: only explicit resistor/capacitor/inductor models supported`)
    }
    passives.push(`${kind}PHYSICAL${i} ${terminals(pos, neg)} ${value(amount, `${component.name} ${quantity}`, true)}`)
    if (kind !== 'C') dcConnections.push([pos, neg])
  }
  if (!sources.length) fail('supply_missing', 'Declare physical voltage sources or explicit source-port supplies; this backend never invents VDD')
  const grounded = new Set(['0'])
  let changed = true
  while (changed) {
    changed = false
    for (const [a, b] of dcConnections) if (grounded.has(a) || grounded.has(b)) for (const node of [a, b]) if (!grounded.has(node)) {
      grounded.add(node)
      changed = true
    }
  }
  for (const source of sourceBindings) if (!grounded.has(source.positiveNode) || !grounded.has(source.negativeNode)) fail('floating_source', `${source.name}: ideal voltage source has no explicit DC connection to channelReference; wire its physical terminals to the modeled supply/reference ports`)
  return { lines: [...sources, ...passives], activeNodes, grounded, sourceBindings, scope: { voltageSources: sources.length, passiveComponents: passives.length, unselectedBoardComponents: 'Excluded from this explicitly selected channel experiment' } }
}


/** Merges an experiment's solver options over the defaults, accepting only the options and methods this backend supports. */
export function simulationSpiceOptions(overrides: SimulationPlan['experiment']['spice_options'] | Record<string, unknown> = {}): SimulationSpiceOptions {
  const options: SimulationSpiceOptions = { reltol: 1e-5, abstol: 1e-12, method: 'gear' }
  for (const [key, input] of Object.entries<unknown>({ ...overrides })) {
    if (key === 'method') {
      if (input !== 'gear' && input !== 'trap') return fail('spice_options', 'Unsupported integration method')
      options.method = input
    } else {
      if (key !== 'reltol' && key !== 'abstol' && key !== 'vntol') return fail('spice_options', `Unsupported solver option ${key}`)
      if ((typeof input !== 'number' && typeof input !== 'string') || !Number.isFinite(Number(input)) || Number(input) <= 0) return fail('spice_options', `Invalid solver option ${key}`)
      options[key] = Number(input)
    }
  }
  return options
}

/**
 * Writes the complete ngspice deck for one experiment: rails, IBIS buffers, the extracted channel
 * and the control block that records every probe to waveform.dat.
 */
export function generalSimulationSpice(plan: SimulationPlan, geometry: Pick<Geometry, 'mappings'>, modeling: { sections: number }, extracted: readonly StageMatrices[], models: readonly CompiledModel[], nodes: CircuitNodes, electrical: ElectricalSources): string {
  const lines = ['Native transient: explicit physical source rails, IBIS run controls and extracted PCB channel']
  const options = simulationSpiceOptions(plan.experiment.spice_options)
  lines.push('.options ' + Object.entries(options).map(([key, input]) => `${key}=${input}`).join(' '), ...electrical.lines)
  for (const [i, model] of models.entries()) {
    const renamed = namespaceSpice(model.source, `IBIS${i}`)
    const wrapper = model.source.match(/^\.subckt\s+\S+\s+(.+)$/mi)
    if (!wrapper) return fail('ibis_contract', 'Converter did not emit a component wrapper')
    const terminals = wrapper[1].trim().split(/\s+/).map(terminal => {
      const id = model.spicePinMapping[terminal]
      if (!id) fail('ibis_contract', `Missing returned terminal ${terminal}`)
      return nodes.node(id)
    })
    lines.push(`* ${safeComment(model.name)}`, renamed.source, `XIBIS${i} ${terminals.join(' ')} ${renamed.wrapper}`)
  }
  if (extracted.some(stage => stage.R.length !== geometry.mappings.length)) fail('matrix_dimension', 'Extracted channels must match every selected signal')
  const channel = [...geometry.mappings.map(mapping => nodes.node(mapping.from)), ...geometry.mappings.map(mapping => nodes.node(mapping.to))]
  if (channel.includes('0') || new Set(channel).size !== channel.length) fail('channel_short', 'Every selected signal must have distinct driver and receiver nodes separate from the reference')
  lines.push(channelSpice(extracted, modeling.sections), `XCHAN ${[...channel, '0'].join(' ')} CHANNEL`)
  validateProbeScope(plan, geometry, models, nodes, electrical)
  // IBIS behavioral sources reference internal voltage-source currents. Probe-only
  // saves discard those branch vectors in upstream ngspice; preserve them all.
  lines.push('.control', 'set wr_singlescale', 'set wr_vecnames', 'set numdgt=17', 'save all', `tran ${num(plan.maxStepSeconds)} ${num(plan.durationSeconds)} ${num(plan.startTimeSeconds)} ${num(plan.maxStepSeconds)}`)
  for (const [i, probe] of plan.probes.entries()) lines.push(`let probe${i} = ${probe.signalNode === '0' ? '0' : `v(${probe.signalNode})`}-${probe.referenceNode === '0' ? '0' : `v(${probe.referenceNode})`}`)
  lines.push(`wrdata waveform.dat ${plan.probes.map((_, i) => `probe${i}`).join(' ')}`, 'quit', '.endc', '.end', '')
  return lines.join('\n')
}

/**
 * Checks that every IBIS reference rail has a DC path to the channel reference and that every probe
 * observes a node inside the modeled circuit, so results never measure an unconnected node.
 */
export function validateProbeScope(plan: SimulationPlan, geometry: Pick<Geometry, 'mappings'>, models: readonly ElectricalModel[], nodes: CircuitNodes, electrical: ElectricalSources): void {
  const active = new Set(electrical.activeNodes)
  for (const model of models) for (const id of Object.values(model.spicePinMapping)) active.add(nodes.node(id))
  for (const model of models) for (const pin of model.metadata?.pins ?? []) for (const [role, id] of Object.entries(pin.references ?? {})) if (!electrical.grounded.has(nodes.node(id))) fail('floating_reference', `${model.name} physical pin ${pin.physicalPin} ${role}: reference rail has no explicit source/passive DC path to channelReference`)
  for (const mapping of geometry.mappings) {
    active.add(nodes.node(mapping.from))
    active.add(nodes.node(mapping.to))
  }
  for (const probe of plan.probes) if (!active.has(probe.signalNode) || !active.has(probe.referenceNode)) fail('probe_observation', `${probe.name}: signal/reference is outside the declared electrical model scope`)
}
