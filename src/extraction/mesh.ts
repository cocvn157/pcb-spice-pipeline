// Meshing (was copper.ts): FastHenry ground-plane mesh, FasterCap copper surfaces (clipper slab
// union + graded earcut triangulation) and panel sizing. Depends on ExtractionSettings, so it is
// extraction's, not board's. Coordinates in mm.
import earcut, { refine } from 'earcut'
import { Clipper64, PolyTree64, ClipType, FillRule, type PolyPath64 } from 'clipper2-ts'
import { polygonContains as contains, ringArea as area, closeRing as closed,
  type CopperPoint as Point, type CopperXYZ as XYZ, type CopperPolygon as Polygon, type CopperSolid as Solid,
  type CopperPath as Path, type RoutedCopper } from '../board'
import { fail } from './diagnostics'

const finite = (value: number) => Number.isFinite(value)

/** Same edge-strip discretization as a rectangular plane mesh, refined locally
 * around boundaries and finite contacts. Every retained cell lies inside copper.
 * Adjacent cells contribute half their transverse width to their shared edge.
 */
export function groundMesh(pour: Solid, meshMm: number, contacts: Array<{point:Point;radius:number}>, contactDivisions=2) {
  const points: Point[]=[], edges: Array<[number,number,number]>=[], indices=new Map<string,number>()
  const node=(x:number,y:number)=>{
    const key=`${x.toFixed(10)},${y.toFixed(10)}`
    let index=indices.get(key)
    if(index===undefined) {index=points.length;indices.set(key,index);points.push([x,y])}
    return index
  }
  const lines=new Map<string,{horizontal:boolean;fixed:number;intervals:Array<[number,number,number]>}>()
  const add=(horizontal:boolean,fixed:number,a:number,b:number,width:number)=>{
    const key=`${horizontal}:${fixed.toFixed(10)}`
    if(!lines.has(key)) lines.set(key,{horizontal,fixed,intervals:[]})
    lines.get(key)!.intervals.push([a,b,width])
  }
  const ring=pour.polygon[0],xs=ring.map(p=>p[0]),ys=ring.map(p=>p[1])
  const boundary=pour.polygon.flatMap(r=>r.map((a,i)=>({a,b:r[(i+1)%r.length]})))
  const visit=(x0:number,y0:number,x1:number,y1:number,borders:typeof boundary,depth:number)=>{
    const crosses=borders.filter(({a,b})=>Math.max(a[0],b[0])>x0+1e-9&&Math.min(a[0],b[0])<x1-1e-9&&Math.max(a[1],b[1])>y0+1e-9&&Math.min(a[1],b[1])<y1-1e-9)
    const center:Point=[(x0+x1)/2,(y0+y1)/2],inside=contains(center,pour.polygon),size=Math.max(x1-x0,y1-y0)
    if(!crosses.length&&!inside) return
    let target=crosses.length?meshMm/4:meshMm
    for(const c of contacts) {
      const dx=Math.max(x0-c.point[0],0,c.point[0]-x1),dy=Math.max(y0-c.point[1],0,c.point[1]-y1)
      if(Math.hypot(dx,dy)<c.radius) target=Math.min(target,c.radius/contactDivisions)
    }
    if(size>target&&depth<28) {
      if(x1-x0>=y1-y0) {const mid=(x0+x1)/2;visit(x0,y0,mid,y1,crosses,depth+1);visit(mid,y0,x1,y1,crosses,depth+1)}
      else {const mid=(y0+y1)/2;visit(x0,y0,x1,mid,crosses,depth+1);visit(x0,mid,x1,y1,crosses,depth+1)}
    } else if(inside&&!crosses.length) {
      add(true,y0,x0,x1,(y1-y0)/2);add(true,y1,x0,x1,(y1-y0)/2)
      add(false,x0,y0,y1,(x1-x0)/2);add(false,x1,y0,y1,(x1-x0)/2)
    }
  }
  visit(Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys),boundary,0)
  for(const line of lines.values()) {
    const events=new Map<number,number>()
    for(const [a,b,w] of line.intervals) {events.set(a,(events.get(a)??0)+w);events.set(b,(events.get(b)??0)-w)}
    const positions=[...events.keys()].sort((a,b)=>a-b)
    let width=0
    for(let i=0;i<positions.length-1;i++) {
      const a=positions[i],b=positions[i+1];width+=events.get(a)!
      if(width>1e-10&&b-a>1e-10) edges.push([line.horizontal?node(a,line.fixed):node(line.fixed,a),line.horizontal?node(b,line.fixed):node(line.fixed,b),width])
    }
  }
  const groups=contacts.map(c=>points.flatMap((p,i)=>Math.hypot(p[0]-c.point[0],p[1]-c.point[1])<=c.radius?[i]:[]))
  if(groups.some(g=>g.length<4)) fail('ground_mesh','Reference contact area is unresolved; decrease extraction.groundMeshMm')
  const parents=points.map((_,i)=>i),root=(i:number):number=>parents[i]===i?i:(parents[i]=root(parents[i]))
  for(const [a,b] of edges) parents[root(a)]=root(b)
  if(groups.length>1&&groups.some(g=>root(g[0])!==root(groups[0][0]))) fail('ground_mesh','Ground mesh disconnects reference contacts; decrease extraction.groundMeshMm')
  return {points,edges,contacts:groups}
}

export function pathSolids(path: Path): Solid[] {
  const solids: Solid[] = []
  for (const s of path.segments) {
    const [x, y, zz] = s.a, [xx, yy, zzz] = s.b, length = Math.hypot(xx - x, yy - y)
    if (!length) {
      const w = s.widthMm / 2, h = s.thicknessMm / 2
      solids.push({ polygon: [[[x - w, y - h], [x + w, y - h], [x + w, y + h], [x - w, y + h]]], zMinMm: Math.min(zz, zzz), zMaxMm: Math.max(zz, zzz) })
    } else {
      const dx = -(yy - y) * s.widthMm / (2 * length), dy = (xx - x) * s.widthMm / (2 * length)
      const limits = { zMinMm: zz - s.thicknessMm / 2, zMaxMm: zz + s.thicknessMm / 2 }
      solids.push({ polygon: [[[x + dx, y + dy], [x - dx, y - dy], [xx - dx, yy - dy], [xx + dx, yy + dy]]], ...limits })
      for (const p of [s.a, s.b]) solids.push({ polygon: [Array.from({ length: 16 }, (_, i): Point => [p[0] + s.widthMm / 2 * Math.cos(2 * Math.PI * i / 16), p[1] + s.widthMm / 2 * Math.sin(2 * Math.PI * i / 16)])], ...limits })
    }
  }
  return solids
}

/** Boolean slab union removes internal faces at bends, vias and pour contacts. */
// Boolean intersections can leave duplicate/collinear vertices separated only
// by floating-point roundoff. This 10-picometre tolerance is below the saved
// board's nanometre coordinate precision; raw source polygons stay unchanged.
const copperEpsilonMm=1e-8
// Boolean geometry uses a local 1e-12 mm integer grid. Keep the source
// route unchanged and retain holes/islands through the clipping hierarchy.
function copperBoolean(subject: Polygon[], clip?: Polygon[]): Polygon[] {
  const scale=1e12, engine=new Clipper64(), tree=new PolyTree64(), result: Polygon[]=[]
  const paths=(polygons: Polygon[])=>polygons.flatMap(p=>p.map((ring,i)=>{
    const oriented=area(ring)*(i?-1:1)>0?ring:[...ring].reverse()
    return oriented.map(([x,y])=>{
      const point={x:Math.round(x*scale),y:Math.round(y*scale)}
      if(!Number.isSafeInteger(point.x)||!Number.isSafeInteger(point.y)) fail('copper_surface','Copper coordinates exceed the integer clipping range')
      return point
    })
  }))
  engine.addSubject(paths(subject))
  if(clip) engine.addClip(paths(clip))
  if(!engine.execute(clip?ClipType.Difference:ClipType.Union,FillRule.NonZero,tree)) fail('copper_surface','Copper polygon clipping failed')
  const ring=(node: PolyPath64)=>closed(node.polygon!.map(p=>[p.x/scale,p.y/scale] as Point))
  const visit=(node: PolyPath64)=>{
    if(node.polygon&&!node.isHole) result.push([ring(node),...Array.from({length:node.count},(_,i)=>ring(node.child(i)))])
    for(let i=0;i<node.count;i++) visit(node.child(i))
  }
  visit(tree)
  return cleanPolygons(result)
}
function cleanPolygons(polygons: Polygon[]): Polygon[] {
  const result: Polygon[]=[]
  for(const polygon of polygons) {
    const rings: Polygon=[]
    for(const ring of polygon) {
      let points=ring.slice(0,-1).filter((p,i)=>i===0||Math.hypot(p[0]-ring[i-1][0],p[1]-ring[i-1][1])>copperEpsilonMm)
      let changed=true
      while(changed&&points.length>=3) {
        changed=false
        points=points.filter((p,i)=>{
          const a=points[(i+points.length-1)%points.length],b=points[(i+1)%points.length]
          const u:Point=[p[0]-a[0],p[1]-a[1]],v:Point=[b[0]-p[0],b[1]-p[1]]
          const length=Math.max(Math.hypot(...u),Math.hypot(...v)),cross=Math.abs(u[0]*v[1]-u[1]*v[0])
          const remove=length===0||cross<=copperEpsilonMm*length&&u[0]*v[0]+u[1]*v[1]>=-(copperEpsilonMm**2)
          if(remove) changed=true
          return !remove
        })
      }
      if(points.length>=3&&Math.abs(area(points))>copperEpsilonMm**2) rings.push(closed(points))
      else if(rings.length===0) break
    }
    if(rings.length) result.push(rings)
  }
  return result
}

// FasterCap panel sizing for routed copper (#28). Huge, extremely thin input panels
// (a 12.6 mm pour face as two triangles, 12.6 mm x 8 um pour sides, 10 mm x 35 um
// trace sides) make FasterCap's collocation system ill-conditioned (hundreds of
// GMRES iterations) and leave C dependent on the -a tolerance. Panels are
// therefore pre-shaped: target edge h(x) = min + grading * distance-to-signal,
// clamped to [min, max]; side walls are split so no panel is longer than
// panelAspectLimit times the copper thickness.
export interface PanelSizing { sizeAt: (p: XYZ) => number; aspectLimit: number }
export const panelAspectLimit = 10, panelGrading = 0.5

// Graded parameters along a segment, independent of its direction so the faces
// on both sides of a shared edge get the same points.
function gradedSplit(a: Point, b: Point, size: (p: Point) => number): number[] {
  const flip = a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]), [p, q] = flip ? [b, a] : [a, b]
  const length = Math.hypot(q[0] - p[0], q[1] - p[1]), ts = [0]
  let t = 0, step = 0
  for (;;) {
    const h = size([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t])
    if (!(h > 0) || !finite(h)) fail('copper_surface', 'Copper panel size must be finite and positive')
    step = h / length
    if (t + step >= 1 - 1e-9) break
    t += step; ts.push(t)
    if (ts.length > 1e6) fail('copper_surface', 'Copper panel sizing produced too many panels')
  }
  // The walk overshoots 1; shrink every piece uniformly so none exceeds its size and the last is no sliver.
  const out = [...ts, t + step].map(v => v / (t + step))
  out[out.length - 1] = 1
  return flip ? out.map(v => 1 - v).reverse() : out
}

// Quality triangulation of one polygon with holes. earcut + refine gives the
// constrained Delaunay triangulation of the polygon vertices; boundary edges are
// then split by gradedSplit, graded quadtree points are inserted inside, and
// Lawson flips (earcut refine) restore the constrained Delaunay mesh.
export function meshPolygon(rings: Point[][], size: (p: Point) => number): Point[][] {
  const pts: Point[] = rings.flat().map(p => [p[0], p[1]]), starts: number[] = []
  let count = rings[0].length
  for (const r of rings.slice(1)) { starts.push(count); count += r.length }
  let tris: number[][] = []
  const key = (i: number, j: number) => i < j ? `${i},${j}` : `${j},${i}`
  let edgeTris = new Map<string, Set<number>>()
  const link = (ti: number) => { const t = tris[ti]; for (let e = 0; e < 3; e++) { const k = key(t[e], t[(e + 1) % 3]); let set = edgeTris.get(k); if (!set) edgeTris.set(k, set = new Set()); set.add(ti) } }
  const unlink = (ti: number) => { const t = tris[ti]; for (let e = 0; e < 3; e++) edgeTris.get(key(t[e], t[(e + 1) % 3]))!.delete(ti) }
  const listeners: Array<(ti: number) => void> = []
  const replace = (ti: number, t: number[]) => { unlink(ti); tris[ti] = t; link(ti); listeners.forEach(f => f(ti)) }
  const add = (t: number[]) => { tris.push(t); link(tris.length - 1); listeners.forEach(f => f(tris.length - 1)) }
  const splitEdge = (a: number, b: number, m: number) => {
    for (const ti of [...edgeTris.get(key(a, b))!]) {
      const t = tris[ti], e = [0, 1, 2].find(e => key(t[e], t[(e + 1) % 3]) === key(a, b))!
      const [x, y, z] = [t[e], t[(e + 1) % 3], t[(e + 2) % 3]]
      replace(ti, [x, m, z]); add([m, y, z])
    }
  }
  const delaunay = (indices: number[]) => {
    refine(indices, pts.flat())
    tris = []; for (let i = 0; i < indices.length; i += 3) tris.push(indices.slice(i, i + 3))
    edgeTris = new Map(); tris.forEach((_, ti) => link(ti))
  }
  delaunay(earcut(pts.flat(), starts))
  // earcut can leave a T-junction where a hole edge is collinear with a triangle
  // edge (two vias in a row); split that edge at the vertex lying on it.
  for (let fixed = true; fixed;) {
    fixed = false
    for (const [k, set] of edgeTris) {
      if (set.size !== 1) continue
      const [a, b] = k.split(',').map(Number), A = pts[a], B = pts[b], dx = B[0] - A[0], dy = B[1] - A[1], l2 = dx * dx + dy * dy
      const v = pts.findIndex((P, i) => {
        if (i === a || i === b) return false
        const t = ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / l2
        return t > 1e-9 && t < 1 - 1e-9 && Math.abs((P[0] - A[0]) * dy - (P[1] - A[1]) * dx) <= 1e-12 * l2
      })
      if (v >= 0) { splitEdge(a, b, v); fixed = true; break }
    }
  }
  // The T-junction repair may already have split a ring edge at vertices lying
  // on it (a ring that touches itself). Grade each existing piece in order.
  const along = (A: Point, B: Point, P: Point) => ((P[0] - A[0]) * (B[0] - A[0]) + (P[1] - A[1]) * (B[1] - A[1])) / ((B[0] - A[0]) ** 2 + (B[1] - A[1]) ** 2)
  const pieces = (ia: number, ib: number): number[] => {
    if (edgeTris.get(key(ia, ib))?.size) return [ia, ib]
    const A = pts[ia], B = pts[ib], dx = B[0] - A[0], dy = B[1] - A[1], l2 = dx * dx + dy * dy
    const inner = pts.map((P, i) => ({ i, t: along(A, B, P) })).filter(({ i, t }) => i !== ia && i !== ib && t > 1e-9 && t < 1 - 1e-9 &&
      Math.abs((pts[i][0] - A[0]) * dy - (pts[i][1] - A[1]) * dx) <= 1e-12 * l2).sort((u, w) => u.t - w.t).map(({ i }) => i)
    const chain = [ia, ...inner, ib]
    if (chain.slice(1).some((w, k) => !edgeTris.get(key(chain[k], w))?.size)) fail('ground_geometry', 'Copper ring edge is missing from its triangulation')
    return chain
  }
  let base = 0
  for (const r of rings) {
    r.forEach((_, i) => {
      const ia = base + i, ib = base + (i + 1) % r.length, A = pts[ia], B = pts[ib], chain = pieces(ia, ib)
      let piece = 1, previous = ia
      for (const t of gradedSplit(A, B, size).slice(1, -1)) {
        while (piece < chain.length - 1 && along(A, B, pts[chain[piece]]) <= t) previous = chain[piece++]
        if (Math.abs(along(A, B, pts[chain[piece]]) - t) < 1e-9 || Math.abs(along(A, B, pts[previous]) - t) < 1e-9) continue
        pts.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]); splitEdge(previous, chain[piece], pts.length - 1); previous = pts.length - 1
      }
    })
    base += r.length
  }
  delaunay(tris.flat())
  const segments = rings.flatMap(r => r.map((p, i): [Point, Point] => [p, r[(i + 1) % r.length]]))
  const segmentDistance = (p: Point, [a, b]: [Point, Point]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
  }
  const inside = (p: Point) => segments.reduce((k, [a, b]) => (a[1] > p[1]) !== (b[1] > p[1]) && p[0] < a[0] + (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) ? !k : k, false)
  const xs = rings[0].map(p => p[0]), ys = rings[0].map(p => p[1]), x0 = Math.min(...xs), y0 = Math.min(...ys)
  const width = Math.max(...xs) - x0, height = Math.max(...ys) - y0, side = Math.min(width, height)
  const nx = Math.max(1, Math.round(width / side)), ny = Math.max(1, Math.round(height / side)), levels: Point[][] = []
  // Graded quadtree: a leaf is split while it is larger than the local size; its
  // centre becomes a vertex if it is clear of the boundary by half the leaf.
  const visit = (x: number, y: number, w: number, h: number, depth: number) => {
    const centre: Point = [x + w / 2, y + h / 2], s = Math.max(w, h)
    if (s > size(centre) && depth < 30) { for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) visit(x + i * w / 2, y + j * h / 2, w / 2, h / 2, depth + 1); return }
    if (inside(centre) && Math.min(...segments.map(sg => segmentDistance(centre, sg))) >= .45 * s) (levels[depth] ??= []).push(centre)
  }
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) visit(x0 + i * width / nx, y0 + j * height / ny, width / nx, height / ny, 0)
  for (const level of levels) {
    if (!level) continue
    const cell = Math.max(width, height) / Math.max(8, Math.sqrt(tris.length)), grid = new Map<string, Set<number>>()
    const register = (ti: number) => {
      const t = tris[ti].map(i => pts[i]), bx = t.map(p => p[0]), by = t.map(p => p[1])
      for (let gx = Math.floor((Math.min(...bx) - x0) / cell); gx <= Math.floor((Math.max(...bx) - x0) / cell); gx++)
        for (let gy = Math.floor((Math.min(...by) - y0) / cell); gy <= Math.floor((Math.max(...by) - y0) / cell); gy++) {
          const k = `${gx},${gy}`; let set = grid.get(k); if (!set) grid.set(k, set = new Set()); set.add(ti)
        }
    }
    tris.forEach((_, ti) => register(ti)); listeners.push(register)
    for (const p of level) {
      const located = [...grid.get(`${Math.floor((p[0] - x0) / cell)},${Math.floor((p[1] - y0) / cell)}`) ?? []].some(ti => {
        const [a, b, c] = tris[ti], [A, B, C] = [pts[a], pts[b], pts[c]], d = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])
        const l1 = ((B[0] - p[0]) * (C[1] - p[1]) - (B[1] - p[1]) * (C[0] - p[0])) / d, l2 = ((C[0] - p[0]) * (A[1] - p[1]) - (C[1] - p[1]) * (A[0] - p[0])) / d, l3 = 1 - l1 - l2, eps = 1e-9
        if (l1 < -eps || l2 < -eps || l3 < -eps) return false
        pts.push(p); const m = pts.length - 1
        if (l1 <= eps) splitEdge(b, c, m); else if (l2 <= eps) splitEdge(c, a, m); else if (l3 <= eps) splitEdge(a, b, m)
        else { replace(ti, [a, b, m]); add([b, c, m]); add([c, a, m]) }
        return true
      })
      if (!located) fail('copper_surface', 'Copper panel refinement could not place an interior vertex')
    }
    listeners.pop(); delaunay(tris.flat())
  }
  return tris.map(t => t.map(i => pts[i]))
}

export function surfacePanels(solids: Solid[], name: string, sizing?: PanelSizing): string {
  const levels = [...new Set(solids.flatMap(s => [s.zMinMm, s.zMaxMm]))].sort((a, b) => a - b), rows = ['* Closed union of actual copper polygons; millimetres; physical capacitance = raw matrix * 0.001']
  const slabs = levels.slice(1).map((high, i) => {
    const low = levels[i], active = solids.filter(s => s.zMinMm < high - 1e-10 && s.zMaxMm > low + 1e-10)
    return active.length ? copperBoolean(active.map(s=>s.polygon)) : []
  })
  const emit = (kind: 'T' | 'Q', pts: XYZ[]) => rows.push(`${kind} ${name} ${pts.flat().join(' ')}`)
  const face = (polys: Polygon[], zz: number, up: boolean) => {
    for (const p of cleanPolygons(polys)) {
      const rings = p.map(r => r.slice(0, -1))
      const polygonArea = Math.abs(area(rings[0])) - rings.slice(1).reduce((s, r) => s + Math.abs(area(r)), 0)
      let triangles: Point[][]
      if (sizing) triangles = meshPolygon(rings, q => sizing.sizeAt([q[0], q[1], zz]))
      else {
        const points = rings.flat(), starts: number[] = []
        let count = rings[0].length
        for (const r of rings.slice(1)) { starts.push(count); count += r.length }
        const flat = points.flat(), indices = earcut(flat, starts)
        refine(indices, flat)
        triangles = []; for (let i = 0; i < indices.length; i += 3) triangles.push(indices.slice(i, i + 3).map(index => points[index]))
      }
      let trianglesArea = 0
      for (const triangle of triangles) {
        trianglesArea += Math.abs(area(triangle))
        if ((area(triangle) > 0) !== up) triangle.reverse()
        emit('T', triangle.map(p => [p[0], p[1], zz]))
      }
      if (Math.abs(trianglesArea - polygonArea) > Math.max(1e-8, polygonArea * 1e-8)) fail('copper_surface', 'Copper triangulation does not preserve polygon area/cutouts')
    }
  }
  for (let i = 0; i < slabs.length; i++) {
    const slab = slabs[i], previous = slabs[i - 1] ?? [], next = slabs[i + 1] ?? []
    if (!slab.length) continue
    const z0 = levels[i], z1 = levels[i + 1], thickness = z1 - z0
    face(previous.length ? copperBoolean(slab, previous) : slab, z0, false)
    face(next.length ? copperBoolean(slab, next) : slab, z1, true)
    for (const p of slab) for (const ring of p) for (let j = 1; j < ring.length; j++) {
      const a = ring[j - 1], b = ring[j]
      const ts = sizing ? gradedSplit(a, b, q => Math.min(sizing.sizeAt([q[0], q[1], (z0 + z1) / 2]), sizing.aspectLimit * thickness)) : [0, 1]
      for (let k = 1; k < ts.length; k++) {
        const u = [a[0] + (b[0] - a[0]) * ts[k - 1], a[1] + (b[1] - a[1]) * ts[k - 1]], v = [a[0] + (b[0] - a[0]) * ts[k], a[1] + (b[1] - a[1]) * ts[k]]
        const along = Math.hypot(v[0] - u[0], v[1] - u[1]), size = sizing ? Math.min(sizing.sizeAt([u[0], u[1], z0]), sizing.aspectLimit * along) : thickness
        const nz = Math.max(1, Math.ceil(thickness / size - 1e-9))
        for (let m = 0; m < nz; m++) {
          const za = m ? z0 + thickness * m / nz : z0, zb = m + 1 < nz ? z0 + thickness * (m + 1) / nz : z1
          emit('Q', [[u[0], u[1], za], [v[0], v[1], za], [v[0], v[1], zb], [u[0], u[1], zb]])
        }
      }
    }
  }
  return rows.join('\n') + '\n'
}

/** Graded panel size: finest on and near the signal copper, growing with distance up to maxPanelLengthMm. */
export function copperPanelSizing(copper: RoutedCopper, maxPanelLengthMm: number): PanelSizing {
  const segments = copper.signals.flatMap(path => path.segments)
  const minimum = Math.min(maxPanelLengthMm, ...segments.map(s => s.widthMm / 2))
  const distance = (p: XYZ) => Math.min(...segments.map(s => {
    const d = s.b.map((v, i) => v - s.a[i]), l2 = d.reduce((sum, v) => sum + v * v, 0)
    const t = l2 ? Math.max(0, Math.min(1, d.reduce((sum, v, i) => sum + v * (p[i] - s.a[i]), 0) / l2)) : 0
    return Math.max(0, Math.hypot(...p.map((v, i) => v - s.a[i] - t * d[i])) - Math.max(s.widthMm, s.thicknessMm) / 2)
  }))
  return { aspectLimit: panelAspectLimit, sizeAt: p => Math.min(maxPanelLengthMm, minimum + panelGrading * distance(p)) }
}

