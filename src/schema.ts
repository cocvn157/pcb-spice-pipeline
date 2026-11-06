import { z } from 'zod'
import * as base from 'circuit-json'

export {
  simulation_ibis_model,
  simulation_ibis_pin_state,
  simulation_digital_stimulus,
  simulation_eye_diagram,
} from 'circuit-json'
export type {
  CircuitJson,
  SimulationExperiment,
  SimulationIbisModel,
  SimulationIbisPinState,
  SimulationDigitalStimulus,
} from 'circuit-json'
import type { CircuitJson } from 'circuit-json'

// Saved boards retain a few older physical serialization forms. Validate their
// equivalent official schemas without changing the original geometry values.
const compatible = (schema: z.ZodTypeAny, normalize: (record: Record<string, unknown>) => Record<string, unknown>) =>
  z.preprocess(value => {
    let normalized = value
    if (value && typeof value === 'object') normalized = normalize({...value})
    return [value, normalized]
  }, z.tuple([z.unknown(), schema])).transform(([original]) => original)

const numericDisplayOffsets = (record: Record<string, unknown>) => {
  for (const key of ['display_offset_x','display_offset_y']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) record[key] = `${value}mm`
  }
  return record
}

const returnBarSchema = z.object({
  width_mm: z.number().finite().positive(),
  thickness_mm: z.number().finite().positive(),
  length_factor: z.number().finite().positive(),
  center_y_mm: z.number().finite(),
  center_z_mm: z.number().finite(),
}).strict()

const physicalCompatibility: Record<string, z.ZodTypeAny> = {
  simulation_experiment: compatible(base.simulation_experiment, record => {
    const channel = record.pcb_spice_channel
    if (!channel || typeof channel !== 'object') return record
    const profiles = Reflect.get(channel, 'straightened_stage_profiles')
    if (!profiles || typeof profiles !== 'object') return record
    const normalizedProfiles: Record<string, unknown> = {}
    for (const [name, profile] of Object.entries(profiles as Record<string, unknown>)) {
      if (profile && typeof profile === 'object' && Array.isArray(Reflect.get(profile, 'return'))) {
        const bars = Reflect.get(profile, 'return') as unknown[]
        if (bars.length > 0 && bars.every(bar => returnBarSchema.safeParse(bar).success)) {
          normalizedProfiles[name] = { ...profile, return: bars[0] }
          continue
        }
      }
      normalizedProfiles[name] = profile
    }
    return { ...record, pcb_spice_channel: { ...channel, straightened_stage_profiles: normalizedProfiles } }
  }),
  source_port: compatible(base.source_port, record => {
    if (record.source_component_id === null) delete record.source_component_id
    return record
  }),
  pcb_component: compatible(base.pcb_component, numericDisplayOffsets),
  // Core wrote anchor_alignment: null and numeric display offsets on groups.
  pcb_group: compatible(base.pcb_group, record => {
    if (record.anchor_alignment === null) delete record.anchor_alignment
    return numericDisplayOffsets(record)
  }),
  // Board- and group-level text: circuit-json omits the owner; older core wrote null.
  pcb_silkscreen_text: compatible(base.pcb_silkscreen_text, record => {
    if (record.pcb_component_id === null) delete record.pcb_component_id
    return record
  }),
  pcb_hole: z.union([base.pcb_hole,z.object({type:z.literal('pcb_hole'),pcb_hole_id:z.string().min(1),
    pcb_component_id:z.null(),hole_shape:z.literal('circle'),hole_diameter:z.number().finite().positive(),
    x:z.number().finite(),y:z.number().finite(),subcircuit_id:z.string().min(1).optional(),is_covered_with_solder_mask:z.boolean().optional()}).passthrough()]),
  pcb_plated_hole: compatible(base.pcb_plated_hole, record => {
    if (record.shape === 'circular_hole_with_rect_pad') return {...record,hole_shape:record.hole_shape??'circle',pad_shape:record.pad_shape??'rect'}
    return record
  }),
}
export function recordSchema(record: { type: string; ftype?: string }): z.ZodTypeAny | undefined {
  let schemaName = record.type
  if (record.type === 'source_component') schemaName = `source_${record.ftype}`
  return physicalCompatibility[record.type] ?? Reflect.get(base, schemaName)
}
export function parseRecord(record: unknown): CircuitJson[number] {
  if (!record || typeof record !== 'object' || !('type' in record) || typeof record.type !== 'string') throw new Error('Circuit record requires a type')
  const schema = recordSchema(record as { type: string })
  if (!schema) throw new Error(`Unknown Circuit JSON record: ${record.type}`)
  return schema.parse(record)
}
