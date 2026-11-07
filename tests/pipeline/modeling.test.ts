// modelingFromCircuitJson (was src/modeling.ts): pcb_spice_channel -> PipelineModeling, and its failures.
import test from 'node:test'
import assert from 'node:assert/strict'
import { modelingFromCircuitJson, runPipeline } from '../../src/pipeline'
import type { CircuitJson } from '../../src/board'
import { inMemoryInput } from '../fixtures/in-memory.mjs'

const channel = {
  reduction: 'routed-copper', sections: 4,
  lanes: [{ name: 'DQ', driver_source_port_id: 'a', receiver_source_port_id: 'b' }],
  reference_source_port_id: 'g', passive_source_component_ids: ['r1'],
  extraction: {
    minimum_frequency_hz: 1e6, maximum_frequency_hz: 1e9, model_frequency_hz: 1e8, filaments: 2, refinement_filaments: 4,
    convergence_tolerance: .05, capacitance_tolerance: .01, reciprocity_tolerance: .02, dc_resistance_tolerance: .05,
    max_panel_length_mm: .5, ground_mesh_size_mm: 1,
  },
  relative_permittivity: 4.2, via_plating_thickness_mm: .025, via_equivalent_width_mm: .15, omit_through_via_stubs: true,
  straightened_stage_profiles: { top: { spacing_mm: .3, relative_permittivity: 3.9, return: { width_mm: 2, thickness_mm: .035, length_factor: 1, center_y_mm: 0, center_z_mm: -.1 } } },
}
/** A pcb_spice transient experiment record carrying `pcb_spice_channel` (null leaves the field out). */
const experiment = (id: string, pcb_spice_channel: unknown = channel): CircuitJson[number] => ({
  type: 'simulation_experiment', simulation_experiment_id: id, name: id, spice_engine: 'pcb_spice', experiment_type: 'spice_transient_analysis',
  ...(pcb_spice_channel === null ? {} : { pcb_spice_channel }),
}) as unknown as CircuitJson[number]
/** Asserts modelingFromCircuitJson fails with pcb_spice_channel and exactly this message. */
const rejects = (input: unknown, message: string): void => assert.throws(() => modelingFromCircuitJson(input as CircuitJson), { code: 'pcb_spice_channel', message: `pcb_spice_channel: ${message}` })

test('a declared pcb_spice_channel maps to the flat PipelineModeling', () => {
  const reordered = Object.fromEntries(Object.entries(channel).reverse())
  assert.deepEqual(modelingFromCircuitJson([experiment('a'), experiment('b', reordered)]), {
    reduction: 'routed-copper', sections: 4,
    lanes: [{ port: 'DQ', from: { sourcePortId: 'a' }, to: { sourcePortId: 'b' } }],
    channelReference: { sourcePortId: 'g' },
    extraction: { minimumHz: 1e6, maximumHz: 1e9, modelHz: 1e8, filaments: 2, refinementFilaments: 4, convergenceTolerance: .05, capTolerance: .01,
      reciprocityTolerance: .02, dcResistanceTolerance: .05, maxPanelLengthMm: .5, groundMeshMm: 1 },
    passiveComponents: [{ sourceComponentId: 'r1' }], relativePermittivity: 4.2, viaPlatingMm: .025, viaEquivalentWidthMm: .15, omitThroughViaStubs: true,
    profiles: { top: { spacingMm: .3, relativePermittivity: 3.9, return: { widthMm: 2, thicknessMm: .035, lengthFactor: 1, centerYMm: 0, centerZMm: -.1 } } },
  })
})

test('missing, invalid and inconsistent channel declarations fail pcb_spice_channel', () => {
  rejects({}, 'Expected a Circuit JSON record array')
  rejects([], 'No pcb_spice transient pcb_spice_channel found; supply modeling or declare pcbSpiceChannel')
  rejects([{ ...experiment('x'), spice_engine: 'ngspice' }], 'No pcb_spice transient pcb_spice_channel found; supply modeling or declare pcbSpiceChannel')
  rejects([experiment('x', null)], 'x: missing pcb_spice_channel; supply modeling or declare pcbSpiceChannel')
  rejects([experiment('x', { ...channel, sections: 0 })], 'x: pcb_spice_channel.sections: Number must be greater than or equal to 1')
  rejects([experiment('x', { ...channel, extraction: { ...channel.extraction, model_frequency_hz: 1e10 } })], 'x: pcb_spice_channel.extraction: Require minimum_frequency_hz <= model_frequency_hz <= maximum_frequency_hz')
  rejects([experiment('x', { ...channel, extraction: { ...channel.extraction, ground_mesh_size_mm: undefined } })], 'x: pcb_spice_channel.extraction.ground_mesh_size_mm: Required for routed-copper')
  rejects([experiment('a'), experiment('b', { ...channel, sections: 5 })], 'All pcb_spice transient experiments must declare deep-equal pcb_spice_channel values for shared extraction')
})

test('runPipeline derives modeling first, so a missing channel fails before admission or any solver work', async () => {
  const { modeling, ...input } = inMemoryInput()
  void modeling
  let solverCalls = 0
  await assert.rejects(runPipeline({ ...input, circuitJson: [...input.circuitJson, { type: 'not_a_record' }] as never, runSolver: async () => {
    solverCalls++
    throw Error('unreachable')
  } } as never),
    { code: 'pcb_spice_channel' })
  assert.equal(solverCalls, 0)
})
