// Circuit JSON record admission (was schema.ts + circuit-schema.mjs). Validation never edits input.
import { z } from 'zod'
import * as base from 'circuit-json'
import type { CircuitJson } from 'circuit-json'
import { fail } from './diagnostics'

export type {
  CircuitJson,
  SimulationExperiment,
  SimulationIbisModel,
  SimulationIbisPinState,
  SimulationDigitalStimulus,
} from 'circuit-json'

/** Saved boards retain a few older physical serialization forms. Validate their
 * equivalent official schemas without changing the original geometry values. */
const compatible = (schema: z.ZodTypeAny, normalize: (record: Record<string, unknown>) => Record<string, unknown>): z.ZodTypeAny =>
  z.preprocess(value => {
    let normalized = value
    if (value && typeof value === 'object') normalized = normalize({...value})
    return [value, normalized]
  }, z.tuple([z.unknown(), schema])).transform(([original]) => original)

/** Rewrites numeric display offsets to the `<n>mm` strings circuit-json expects (on the validation copy only). */
const numericDisplayOffsets = (record: Record<string, unknown>): Record<string, unknown> => {
  for (const key of ['display_offset_x','display_offset_y']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) record[key] = `${value}mm`
  }
  return record
}

const physicalCompatibility: Record<string, z.ZodTypeAny> = {
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
/** Picks the zod schema for one record by its type (source components by ftype), preferring the compatibility schemas. */
export function recordSchema(record: { type: string; ftype?: string }): z.ZodTypeAny | undefined {
  let schemaName = record.type
  if (record.type === 'source_component') schemaName = `source_${record.ftype}`
  return physicalCompatibility[record.type] ?? Reflect.get(base, schemaName)
}
/** Parses one Circuit JSON record with its registered schema, throwing a plain Error for missing or unknown types. */
export function parseRecord(record: unknown): CircuitJson[number] {
  if (!record || typeof record !== 'object' || !('type' in record) || typeof record.type !== 'string') throw new Error('Circuit record requires a type')
  const schema = recordSchema(record as { type: string })
  if (!schema) throw new Error(`Unknown Circuit JSON record: ${record.type}`)
  return schema.parse(record)
}

/** Select the registered record schema directly, avoiding a union diagnostic
 * containing hundreds of unrelated alternatives. Validation never edits input. */
export function validateCircuitRecords(records: unknown): void {
  if(!Array.isArray(records)) fail('circuit_schema','Expected a Circuit JSON record array')
  for(const record of records as Array<Record<string, unknown> | null | undefined>) {
    const type=record?.type
    const id=record?.[`${type}_id`]??record?.name??'(unnamed)'
    const schema: Partial<z.ZodTypeAny> | undefined=typeof type==='string'?recordSchema(record as { type: string; ftype?: string }):undefined
    if(!schema?.safeParse) fail('circuit_schema',`${type??'(missing type)'} ${id}: no registered record schema`)
    const parsed=schema.safeParse(record)
    if(!parsed.success) {
      const issue=parsed.error.issues[0]
      const path=issue.path?.join('.')
      fail('circuit_schema',`${type} ${id}: ${path?path+': ':''}${issue.message}`)
    }
  }
}
