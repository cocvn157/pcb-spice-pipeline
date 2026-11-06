import type { CircuitJson } from './schema.js'
import type { BoardStackup } from './stackup.js'
import { connectedSourceIds } from './copper.js'
import { fail } from './matrices.mjs'

/** Width of each derived return bar. The return current of a stage stays
 * within a few dielectric heights of the signal, so a 2 mm strip of each
 * adjacent plane carries it; widening it only adds solver panels. */
export const derivedReturnWidthMm = 2

export interface StageReturnPart { layer: string; centerZMm: number; thicknessMm: number; widthMm: number }
export interface StageReturn { relativePermittivity: number; parts: StageReturnPart[] }

/** Copper layers carrying a pour on the reference ground net. */
export function groundPourLayers(circuit: CircuitJson, referenceSourcePortId?: string): Set<string> {
  const nets = referenceSourcePortId
    ? connectedSourceIds(circuit, referenceSourcePortId)
    : new Set(circuit.filter(e => e.type === 'source_net' && e.is_ground).map(e => e.type === 'source_net' ? e.source_net_id : ''))
  return new Set(circuit.filter(e => e.type === 'pcb_copper_pour').filter(e => nets.has(e.source_net_id ?? '')).map(e => e.type === 'pcb_copper_pour' ? e.layer : ''))
}

/** Return bars for a wire stage on `layer`: one under each directly adjacent
 * copper layer that carries a ground pour, so a stripline gets both planes.
 * Heights, thicknesses and the dielectric between come from pcb_stackup. */
export function stackupStageReturn(stackup: BoardStackup, groundLayers: Set<string>, layer: string): StageReturn {
  const copper = stackup.copperLayers, index = copper.findIndex(l => l.name === layer)
  if (index < 0) fail('stackup', `No copper z range for ${layer}`)
  const signal = copper[index], center = (l: { zMinMm: number; zMaxMm: number }) => (l.zMinMm + l.zMaxMm) / 2
  const planes = [copper[index - 1], copper[index + 1]].filter(l => l && groundLayers.has(l.name))
  if (!planes.length)
    fail('return_geometry', `${layer}: no adjacent copper layer carries a ground pour; supply a straightened-stage profile for ${layer}`)
  const lo = Math.min(...planes.map(l => l.zMinMm), signal.zMinMm), hi = Math.max(...planes.map(l => l.zMaxMm), signal.zMaxMm)
  const between = stackup.dielectrics.filter(d => d.zMinMm >= lo - 1e-9 && d.zMaxMm <= hi + 1e-9)
  if (!between.length || between.some(d => d.relativePermittivity === undefined))
    fail('return_geometry', `${layer}: dielectric relative permittivity between the signal and its ground planes is required in pcb_stackup`)
  const thickness = between.reduce((sum, d) => sum + d.zMaxMm - d.zMinMm, 0)
  return {
    relativePermittivity: between.reduce((sum, d) => sum + (d.zMaxMm - d.zMinMm) * d.relativePermittivity!, 0) / thickness,
    parts: planes.map(l => ({ layer: l.name, centerZMm: center(l) - center(signal), thicknessMm: l.zMaxMm - l.zMinMm, widthMm: derivedReturnWidthMm })),
  }
}

type Point = { x: number; y: number; layer?: string; route_type: string }
/** Median centre-to-centre distance between consecutive lanes on one layer,
 * measured from the routed points of each lane to the next lane's segments. */
export function measuredLaneSpacingMm(routes: Point[][], layer: string): number {
  const wires = routes.map(r => r.filter(p => p.route_type === 'wire' && p.layer === layer))
  const gaps: number[] = []
  for (let j = 0; j + 1 < wires.length; j++) {
    const [a, b] = [wires[j], wires[j + 1]], d: number[] = []
    for (const p of a) {
      let best = Infinity
      for (let k = 1; k < b.length; k++) {
        const u = b[k - 1], v = b[k], dx = v.x - u.x, dy = v.y - u.y, l = dx * dx + dy * dy
        const t = l ? Math.max(0, Math.min(1, ((p.x - u.x) * dx + (p.y - u.y) * dy) / l)) : 0
        best = Math.min(best, Math.hypot(p.x - u.x - t * dx, p.y - u.y - t * dy))
      }
      if (Number.isFinite(best)) d.push(best)
    }
    if (!d.length) fail('lane_spacing', `${layer}: lanes ${j} and ${j + 1} share no routed segments on this layer; supply a straightened-stage profile`)
    d.sort((x, y) => x - y)
    gaps.push(d[Math.floor(d.length / 2)])
  }
  return gaps.reduce((s, g) => s + g, 0) / gaps.length
}
