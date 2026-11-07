import { pcb_stackup, type CircuitJson } from 'circuit-json'
import { fail } from './diagnostics.js'

export const defaultCopperConductivitySm = 5.8e7
export interface CopperLayer {
  name: string
  zMinMm: number
  zMaxMm: number
  conductivitySm: number
}
export interface DielectricLayer {
  material?: string
  zMinMm: number
  zMaxMm: number
  relativePermittivity?: number
}
export interface BoardStackup {
  pcbBoardId: string
  copperLayers: CopperLayer[]
  dielectrics: DielectricLayer[]
  relativePermittivity?: number
  viaPlatingMm?: number
}

/** Public. Circuit JSON is top→bottom; solver z=0 is the upper face of bottom copper. */
export function stackupFromCircuitJson(circuit: CircuitJson): BoardStackup {
  const boards = circuit.filter(record => record.type === 'pcb_board')
  const records = circuit.filter(record => record.type === 'pcb_stackup')
  // Plain Error (no code), exactly as before the module split.
  if (!records.length) throw new Error(`Board ${boards[0]?.pcb_board_id ?? '(missing pcb_board)'} has no pcb_stackup. Set fabricatorPreset (e.g. "jlcpcb_standard") on <board> so the JLC stackup template is resolved into Circuit JSON.`)
  if (records.length !== 1) fail('stackup', 'One pcb_stackup per simulation entry is supported')
  const stackup = pcb_stackup.parse(records[0])
  if (boards.length !== 1 || boards[0].pcb_board_id !== stackup.pcb_board_id)
    fail('stackup', `Expected one pcb_board referenced by ${stackup.pcb_board_id}`)
  const layers = stackup.layers.filter(layer => layer.layer_type !== 'soldermask')
  const copper = layers.filter(layer => layer.layer_type === 'copper')
  if (copper.length !== boards[0].num_layers || copper[0]?.layer !== 'top' || copper.at(-1)?.layer !== 'bottom' || new Set(copper.map(layer => layer.layer)).size !== copper.length)
    fail('stackup', 'Copper layers must be distinct, ordered top to bottom, and match pcb_board.num_layers')
  if (layers[0]?.layer_type !== 'copper' || layers.at(-1)?.layer_type !== 'copper')
    fail('stackup', 'Physical stack must start and end with copper (outside soldermask is ignored)')
  const copperLayers: CopperLayer[] = [], dielectrics: DielectricLayer[] = []
  const round = (value: number) => Math.round(value * 1e10) / 1e10
  let z = -copper.at(-1)!.thickness
  for (const layer of [...layers].reverse()) {
    const zMinMm = round(z), zMaxMm = round(z + layer.thickness)
    if (layer.layer_type === 'copper') copperLayers.push({ name: layer.layer, zMinMm, zMaxMm,
      conductivitySm: layer.electrical_conductivity_s_per_m ?? defaultCopperConductivitySm })
    else dielectrics.push({ material: layer.material_name, zMinMm, zMaxMm, relativePermittivity: layer.relative_permittivity })
    z = zMaxMm
  }
  for (let i = 1; i < copperLayers.length; i++) if (copperLayers[i].zMinMm <= copperLayers[i - 1].zMaxMm)
    fail('stackup', 'Copper layers require a positive dielectric gap')
  // Native decks use one homogeneous dielectric. Preserve every layer above,
  // and expose a thickness-weighted approximation only when all Dk is known.
  const thickness = dielectrics.reduce((sum, layer) => sum + layer.zMaxMm - layer.zMinMm, 0)
  const relativePermittivity = thickness > 0 && dielectrics.every(layer => layer.relativePermittivity !== undefined)
    ? dielectrics.reduce((sum, layer) => sum + (layer.zMaxMm - layer.zMinMm) * layer.relativePermittivity!, 0) / thickness : undefined
  return { pcbBoardId: stackup.pcb_board_id, copperLayers, dielectrics, relativePermittivity, viaPlatingMm: stackup.plated_hole_copper_thickness }
}
