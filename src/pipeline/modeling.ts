import { z } from 'zod'
import type { CircuitJson, BoardModeling } from '../board'
import type { ExtractionModeling } from '../extraction'
import type { SimulationModeling } from '../simulation'
import type { DdrModeling } from '../ddr'
import type { BufferModeling } from '../buffers'
import { fail } from './diagnostics'

/**
 * The public, flat `Modeling` shape is unchanged for callers; it is the intersection of
 * slices, each owned (and validated) by the domain that reads it.
 */
export type Modeling = BoardModeling & ExtractionModeling & SimulationModeling & DdrModeling
export type PipelineModeling = Modeling & BufferModeling

const positive = z.number().finite().positive()
const id = z.string().min(1)
const returnBar = z.object({ width_mm: positive, thickness_mm: positive, length_factor: positive,
  center_y_mm: z.number().finite(), center_z_mm: z.number().finite() })
const profile = z.object({
  spacing_mm: positive, relative_permittivity: positive,
  return: z.union([returnBar, z.array(returnBar).min(1)]),
})
const channelSchema = z.object({
  reduction: z.enum(['routed-copper', 'straightened-stages']),
  sections: z.number().int().min(1).max(128),
  lanes: z.array(z.object({ name: id, driver_source_port_id: id, receiver_source_port_id: id })).min(1).max(3),
  reference_source_port_id: id,
  passive_source_component_ids: z.array(id).optional(),
  extraction: z.object({
    minimum_frequency_hz: positive, maximum_frequency_hz: positive, model_frequency_hz: positive,
    filaments: positive.int(), refinement_filaments: positive.int(),
    convergence_tolerance: positive, capacitance_tolerance: positive,
    reciprocity_tolerance: positive, dc_resistance_tolerance: positive,
    max_panel_length_mm: positive, ground_mesh_size_mm: positive.optional(),
  }),
  relative_permittivity: positive.optional(), via_plating_thickness_mm: positive.optional(),
  via_equivalent_width_mm: positive.optional(), omit_through_via_stubs: z.boolean().optional(),
  straightened_stage_profiles: z.record(profile).optional(),
}).superRefine((channel, ctx) => {
  const extraction = channel.extraction
  /** Records one custom validation failure at `path` so zod reports it with the rest. */
  const issue = (path: string[], message: string): void => ctx.addIssue({ code: 'custom', path, message })
  if (extraction.minimum_frequency_hz > extraction.model_frequency_hz || extraction.model_frequency_hz > extraction.maximum_frequency_hz)
    issue(['extraction'], 'Require minimum_frequency_hz <= model_frequency_hz <= maximum_frequency_hz')
  if (extraction.refinement_filaments <= extraction.filaments)
    issue(['extraction', 'refinement_filaments'], 'Must exceed filaments')
  if (new Set(channel.lanes.map(lane => lane.name)).size !== channel.lanes.length)
    issue(['lanes'], 'Lane names must be distinct')
  if (channel.reduction === 'routed-copper' && extraction.ground_mesh_size_mm === undefined)
    issue(['extraction', 'ground_mesh_size_mm'], 'Required for routed-copper')
})

/** JSON with object keys sorted, so two channels compare equal regardless of key order. */
const canonical = (value: unknown): string => JSON.stringify(value, (_, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)

/**
 * Public. Derives PipelineModeling from the `pcb_spice_channel` declared on every pcb_spice transient
 * simulation_experiment (today's src/modeling.ts, unchanged messages; fails 'pcb_spice_channel').
 */
export function modelingFromCircuitJson(circuitJson: CircuitJson): PipelineModeling {
  if (!Array.isArray(circuitJson)) fail('pcb_spice_channel', 'Expected a Circuit JSON record array')
  const experiments = circuitJson.filter(record => record.type === 'simulation_experiment').filter(record =>
    record.spice_engine === 'pcb_spice' && record.experiment_type === 'spice_transient_analysis')
  if (!experiments.length) fail('pcb_spice_channel', 'No pcb_spice transient pcb_spice_channel found; supply modeling or declare pcbSpiceChannel')
  const channels = experiments.map(record => {
    const raw = Reflect.get(record, 'pcb_spice_channel')
    if (raw === undefined) fail('pcb_spice_channel', `${record.simulation_experiment_id}: missing pcb_spice_channel; supply modeling or declare pcbSpiceChannel`)
    const parsed = channelSchema.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      fail('pcb_spice_channel', `${record.simulation_experiment_id}: pcb_spice_channel.${issue.path.join('.')}: ${issue.message}`)
    }
    return parsed.data
  })
  if (channels.some(channel => canonical(channel) !== canonical(channels[0])))
    fail('pcb_spice_channel', 'All pcb_spice transient experiments must declare deep-equal pcb_spice_channel values for shared extraction')
  const channel = channels[0]
  const extraction = channel.extraction
  const modeling: PipelineModeling = {
    reduction: channel.reduction, sections: channel.sections,
    lanes: channel.lanes.map(lane => ({ port: lane.name, from: { sourcePortId: lane.driver_source_port_id }, to: { sourcePortId: lane.receiver_source_port_id } })),
    channelReference: { sourcePortId: channel.reference_source_port_id },
    extraction: { minimumHz: extraction.minimum_frequency_hz, maximumHz: extraction.maximum_frequency_hz, modelHz: extraction.model_frequency_hz,
      filaments: extraction.filaments, refinementFilaments: extraction.refinement_filaments, convergenceTolerance: extraction.convergence_tolerance,
      capTolerance: extraction.capacitance_tolerance, reciprocityTolerance: extraction.reciprocity_tolerance,
      dcResistanceTolerance: extraction.dc_resistance_tolerance, maxPanelLengthMm: extraction.max_panel_length_mm },
  }
  if (extraction.ground_mesh_size_mm !== undefined) modeling.extraction.groundMeshMm = extraction.ground_mesh_size_mm
  if (channel.passive_source_component_ids !== undefined) modeling.passiveComponents = channel.passive_source_component_ids.map(sourceComponentId => ({ sourceComponentId }))
  if (channel.relative_permittivity !== undefined) modeling.relativePermittivity = channel.relative_permittivity
  if (channel.via_plating_thickness_mm !== undefined) modeling.viaPlatingMm = channel.via_plating_thickness_mm
  if (channel.via_equivalent_width_mm !== undefined) modeling.viaEquivalentWidthMm = channel.via_equivalent_width_mm
  if (channel.omit_through_via_stubs !== undefined) modeling.omitThroughViaStubs = channel.omit_through_via_stubs
  /** Converts one snake_case return-bar schema entry to the camelCase ReturnBarProfile shape. */
  const mapReturnBar = (bar: z.infer<typeof returnBar>): { widthMm: number; thicknessMm: number; lengthFactor: number; centerYMm: number; centerZMm: number } => ({
    widthMm: bar.width_mm, thicknessMm: bar.thickness_mm, lengthFactor: bar.length_factor,
    centerYMm: bar.center_y_mm, centerZMm: bar.center_z_mm,
  })
  if (channel.straightened_stage_profiles !== undefined) modeling.profiles = Object.fromEntries(Object.entries(channel.straightened_stage_profiles).map(([name, stageProfile]) => [name, {
    spacingMm: stageProfile.spacing_mm, relativePermittivity: stageProfile.relative_permittivity,
    return: Array.isArray(stageProfile.return) ? stageProfile.return.map(mapReturnBar) : mapReturnBar(stageProfile.return),
  }]))
  return modeling
}
