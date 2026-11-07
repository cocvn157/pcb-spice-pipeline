// Planar polygon helpers shared by board (connectivity) and extraction (meshing), mm.
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
