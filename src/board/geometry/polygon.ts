// Planar polygon helpers shared by board (connectivity) and extraction (meshing), mm.
import type { CopperPoint as Point, CopperPolygon as Polygon } from './types'

export const ringArea = (ring: Point[]) => ring.reduce((s, p, i) => {
  const q = ring[(i + 1) % ring.length]; return s + p[0] * q[1] - q[0] * p[1]
}, 0) / 2
export const closeRing = (ring: Point[]) => [...ring, ring[0]]

const ringBounds=new WeakMap<Point[],[number,number,number,number]>()
function inRing(p: Point, ring: Point[]): boolean {
  let box=ringBounds.get(ring)
  if(!box) {box=[Math.min(...ring.map(p=>p[0])),Math.min(...ring.map(p=>p[1])),Math.max(...ring.map(p=>p[0])),Math.max(...ring.map(p=>p[1]))];ringBounds.set(ring,box)}
  if(p[0]<box[0]||p[1]<box[1]||p[0]>box[2]||p[1]>box[3]) return false
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j]
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}
/** Point in outer ring and in no cutout. */
export const polygonContains = (p: Point, polygon: Polygon) => inRing(p, polygon[0]) && !polygon.slice(1).some(ring => inRing(p, ring))
