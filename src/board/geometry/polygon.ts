// Planar polygon helpers shared by board (connectivity) and extraction (meshing), mm.
import { Clipper64, PolyTree64, ClipType, FillRule, type PolyPath64, type Paths64 } from 'clipper2-ts'
import { fail } from '../diagnostics'
import type { CopperPoint as Point, CopperPolygon as Polygon } from './types'

/** Signed shoelace area of a ring: positive when counter-clockwise, so callers can fix winding. */
export const ringArea = (ring: Point[]): number => ring.reduce((s, p, i) => {
  const q = ring[(i + 1) % ring.length]
  return s + p[0] * q[1] - q[0] * p[1]
}, 0) / 2
/** Copy of the ring with its first point repeated at the end, for formats that want closed loops. */
export const closeRing = (ring: Point[]): Point[] => [...ring, ring[0]]

const ringBounds=new WeakMap<Point[],[number,number,number,number]>()
/** Even-odd point-in-ring test, with a cached bounding box to reject far points quickly. */
function inRing(p: Point, ring: Point[]): boolean {
  let box=ringBounds.get(ring)
  if(!box) {
    box=[Math.min(...ring.map(p=>p[0])),Math.min(...ring.map(p=>p[1])),Math.max(...ring.map(p=>p[0])),Math.max(...ring.map(p=>p[1]))]
    ringBounds.set(ring,box)
  }
  if(p[0]<box[0]||p[1]<box[1]||p[0]>box[2]||p[1]>box[3]) return false
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}
/** Point in outer ring and in no cutout. */
export const polygonContains = (p: Point, polygon: Polygon): boolean => inRing(p, polygon[0]) && !polygon.slice(1).some(ring => inRing(p, ring))

// Boolean intersections can leave duplicate/collinear vertices separated only
// by floating-point roundoff. This 10-picometre tolerance is below the saved
// board's nanometre coordinate precision; raw source polygons stay unchanged.
const copperEpsilonMm = 1e-8

/** Drops near-duplicate and collinear vertices left by clipping roundoff, and rings that collapse to no area. */
export function cleanPolygons(polygons: Polygon[]): Polygon[] {
  const result: Polygon[] = []
  for (const polygon of polygons) {
    const rings: Polygon = []
    for (const ring of polygon) {
      let points = ring.slice(0, -1).filter((p, i) => i === 0 || Math.hypot(p[0] - ring[i - 1][0], p[1] - ring[i - 1][1]) > copperEpsilonMm)
      let changed = true
      while (changed && points.length >= 3) {
        changed = false
        points = points.filter((p, i) => {
          const a = points[(i + points.length - 1) % points.length]
          const b = points[(i + 1) % points.length]
          const u: Point = [p[0] - a[0], p[1] - a[1]]
          const v: Point = [b[0] - p[0], b[1] - p[1]]
          const length = Math.max(Math.hypot(...u), Math.hypot(...v))
          const cross = Math.abs(u[0] * v[1] - u[1] * v[0])
          const remove = length === 0 || cross <= copperEpsilonMm * length && u[0] * v[0] + u[1] * v[1] >= -(copperEpsilonMm ** 2)
          if (remove) changed = true
          return !remove
        })
      }
      if (points.length >= 3 && Math.abs(ringArea(points)) > copperEpsilonMm ** 2) rings.push(closeRing(points))
      else if (rings.length === 0) break
    }
    if (rings.length) result.push(rings)
  }
  return result
}

/**
 * Boolean geometry uses a local 1e-12 mm integer grid. Keep the source
 * route unchanged and retain holes/islands through the clipping hierarchy.
 */
export function copperBoolean(subject: Polygon[], clip?: Polygon[]): Polygon[] {
  const scale = 1e12
  const engine = new Clipper64()
  const tree = new PolyTree64()
  const result: Polygon[] = []
  /** Converts polygons to Clipper integer paths, orienting outer rings and holes oppositely. */
  const paths = (polygons: Polygon[]): Paths64 => polygons.flatMap(p => p.map((ring, i) => {
    const oriented = ringArea(ring) * (i ? -1 : 1) > 0 ? ring : [...ring].reverse()
    return oriented.map(([x, y]) => {
      const point = { x: Math.round(x * scale), y: Math.round(y * scale) }
      if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)) fail('copper_surface', 'Copper coordinates exceed the integer clipping range')
      return point
    })
  }))
  engine.addSubject(paths(subject))
  if (clip) engine.addClip(paths(clip))
  if (!engine.execute(clip ? ClipType.Difference : ClipType.Union, FillRule.NonZero, tree)) fail('copper_surface', 'Copper polygon clipping failed')
  /** Converts one Clipper result path back to a closed millimetre ring. */
  const ring = (node: PolyPath64): Point[] => closeRing(node.polygon!.map(p => [p.x / scale, p.y / scale] as Point))
  /** Collects every outer polygon in the clip tree together with its direct holes. */
  const visit = (node: PolyPath64): void => {
    if (node.polygon && !node.isHole) result.push([ring(node), ...Array.from({ length: node.count }, (_, i) => ring(node.child(i)))])
    for (let i = 0; i < node.count; i++) visit(node.child(i))
  }
  visit(tree)
  return cleanPolygons(result)
}

