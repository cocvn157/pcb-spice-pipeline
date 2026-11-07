import test from 'node:test'
import assert from 'node:assert/strict'
import { geometryFromCircuitJson } from '../../src/board'
import { fastHenryDeck, fasterCapDeck, groundMesh, copperFasterCapDeck, panelAspectLimit, meshPolygon } from '../../src/extraction'
import { groundPlaneFixture, routedGroundPlaneFixture } from '../fixtures/ground-plane'

/** Checks a FasterCap panel file is a closed, consistently wound surface and returns its enclosed volume in m^3 (divergence theorem). */
function closedSurfaceVolume(surface: string): number {
  assert.match(surface.split('\n')[0], /\bmillimetres\b/)
  const panels = surface.split('\n').filter(r => /^[TQ] /.test(r)).map(row => {
    const values = row.split(' ').slice(2).map(value => Number(value) * 1e-3)
    return Array.from({ length: values.length / 3 }, (_, i) => values.slice(i * 3, i * 3 + 3))
  })
  /** Rounded text key so the same vertex from different panels compares equal. */
  const key = (p: number[]): string => p.map(n => n.toPrecision(12)).join(',')
  const vertices = [...new Map(panels.flat().map(p => [key(p), p])).values()]
  const edges = new Map<string, { count: number; orientation: number }>()
  let volume = 0
  for (const p of panels) {
    for (let i = 0; i < p.length; i++) {
      const a = p[i]
      const b = p[(i + 1) % p.length]
      const d = b.map((v, j) => v - a[j])
      const length2 = d.reduce((s, v) => s + v * v, 0)
      assert.ok(length2 > 0, 'surface edges must have nonzero length')
      // A slab union can split one side of an edge into several collinear edges.
      const cuts = vertices.flatMap(v => {
        const t = v.reduce((s, n, j) => s + (n - a[j]) * d[j], 0) / length2
        return t >= -1e-10 && t <= 1 + 1e-10 && Math.hypot(...v.map((n, j) => n - a[j] - t * d[j])) < 1e-13 ? [{ t, v }] : []
      }).sort((a, b) => a.t - b.t)
      for (let j = 1; j < cuts.length; j++) {
        const [u, v] = [key(cuts[j - 1].v), key(cuts[j].v)]
        const id = [u, v].sort().join(' ')
        const edge = edges.get(id) ?? { count: 0, orientation: 0 }
        edge.count++
        edge.orientation += u < v ? 1 : -1
        edges.set(id, edge)
      }
    }
    for (let i = 1; i < p.length - 1; i++) {
      const [a, b, c] = [p[0], p[i], p[i + 1]]
      volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
    }
  }
  assert.ok(edges.size > 0)
  for (const edge of edges.values()) assert.deepEqual(edge, { count: 2, orientation: 0 }, 'each solid edge must have two oppositely wound faces')
  return volume
}

test('FasterCap reference lead and via union forms a closed outward-facing solid', () => {
  const { circuit, modeling } = routedGroundPlaneFixture()
  const cell = geometryFromCircuitJson(circuit, modeling).cells[0]
  const files = fasterCapDeck(cell, modeling.extraction)
  for (const name of ['sig0', 'sig1', 'return']) assert.ok(closedSurfaceVolume(files[`${name}.txt`]) > 0)
  assert.ok(closedSurfaceVolume(files['return.txt']) > 47 * .035 * 1e-9, 'ground lead and via add copper to the physical plane')
})

test('adaptive ground mesh preserves the cutout and resolves connected finite contact areas', () => {
  const { circuit, modeling } = groundPlaneFixture()
  const copper = geometryFromCircuitJson(circuit, modeling).cells[0].routedCopper!
  const contacts = copper.connections.map(p => ({ point: [p.terminals[1][0], p.terminals[1][1]] as [number, number], radius: p.contactRadiusMm! }))
  const mesh = groundMesh(copper.pours[0], modeling.extraction.groundMeshMm!, contacts)
  const parents = mesh.points.map((_, i) => i)
  /** Union-find root of a mesh point, used to check all contacts are connected. */
  const root = (i: number): number => parents[i] === i ? i : (parents[i] = root(parents[i]))
  for (const [a, b, width] of mesh.edges) {
    assert.ok(Number.isFinite(width) && width > 0)
    parents[root(a)] = root(b)
    for (const t of [0, .25, .5, .75, 1]) {
      const x = mesh.points[a][0] * (1 - t) + mesh.points[b][0] * t
      const y = mesh.points[a][1] * (1 - t) + mesh.points[b][1] * t
      assert.ok(x >= -1 && x <= 11 && y >= -2 && y <= 2)
      assert.ok(!(x > 4 && x < 6 && y > -.25 && y < .25), 'mesh must not bridge a copper cutout')
    }
  }
  for (const [i, group] of mesh.contacts.entries()) {
    assert.ok(group.length >= 4, 'reference contact must resolve a finite area')
    for (const id of group) {
      assert.equal(root(id), root(mesh.contacts[0][0]))
      assert.ok(Math.hypot(mesh.points[id][0] - contacts[i].point[0], mesh.points[id][1] - contacts[i].point[1]) <= contacts[i].radius)
    }
  }
  assert.throws(() => groundMesh(copper.pours[0], .5, [{ point: [5, 0], radius: .1 }]), /ground_mesh/)
})

test('both native decks use ground polygon cutouts and original trace coordinates', () => {
  const { circuit, modeling } = groundPlaneFixture()
  const cell = geometryFromCircuitJson(circuit, modeling).cells[0]
  const fh = fastHenryDeck(cell, modeling.extraction)
  const fc = fasterCapDeck(cell, modeling.extraction)
  assert.match(fh,/ground-plane layer=bottom cutouts=1/)
  assert.match(fh,/Eg0_0 /)
  assert.match(fh,/Np0_\d+ x=-0.001 y=-0.002/)
  assert.match(fh,/N0a x=0 y=-0.000375/)
  assert.match(fh,/\.external N2a N2b/)
  assert.match(fc['return.txt'],/T return/)
  assert.match(fc['return.txt'],/Q return/)
  assert.match(fc['channel.lst'].split('\n')[0], /\bmillimetres\b/)
  // Divergence theorem independently verifies the closed, outward-facing solid
  // volume: (12*4 - 2*.5) * .035 mm^3, including the hole side walls.
  const volume = closedSurfaceVolume(fc['return.txt'])
  assert.ok(Math.abs(volume-47*.035*1e-9)<1e-20)
  assert.ok(fh.length < fastHenryDeck(cell,{...modeling.extraction,groundMeshMm:.25}).length)
})

test('FasterCap copper panels are pre-shaped: graded faces, short side walls, same closed solid (#28)', () => {
  const { circuit, modeling } = groundPlaneFixture()
  const cell = geometryFromCircuitJson(circuit, modeling).cells[0]
  /** Parses a panel file into its T/Q panels and their corner points. */
  const panels = (surface: string): Array<{ kind: string; points: number[][] }> => surface.split('\n').filter(r => /^[TQ] /.test(r)).map(row => {
    const values = row.split(' ').slice(2).map(Number)
    return { kind: row[0], points: Array.from({ length: values.length / 3 }, (_, i) => values.slice(i * 3, i * 3 + 3)) }
  })
  /** Edge lengths of one panel, in order around it. */
  const edges = (points: number[][]): number[] => points.map((p, i) => Math.hypot(...p.map((v, j) => v - points[(i + 1) % points.length][j])))
  const legacy = copperFasterCapDeck(cell)
  const shaped = fasterCapDeck(cell, modeling.extraction)
  for (const name of ['sig0', 'sig1', 'return']) {
    const before = panels(legacy[`${name}.txt`])
    const after = panels(shaped[`${name}.txt`])
    assert.ok(after.length > before.length, `${name} is subdivided`)
    // Subdivision keeps the exact closed, outward-facing copper solid.
    assert.ok(Math.abs(closedSurfaceVolume(shaped[`${name}.txt`]) - closedSurfaceVolume(legacy[`${name}.txt`])) < 1e-20)
    for (const { kind, points } of after) {
      const e = edges(points)
      assert.ok(Math.min(...e) > 0)
      if (kind === 'T') assert.ok(Math.max(...e) <= modeling.extraction.maxPanelLengthMm, 'face panels respect maxPanelLengthMm')
      else assert.ok(Math.max(e[0], e[2]) <= panelAspectLimit * Math.min(e[1], e[3]) * (1 + 1e-9), 'side walls are not thin slivers')
    }
  }
  // Pour faces are graded: fine panels under the trace (y = -.375 / .375), coarse far away.
  const pourFace = panels(shaped['return.txt']).filter(p => p.kind === 'T' && p.points.every(q => q[2] === p.points[0][2]))
  /** Mean longest-edge length of pour-face panels near the signal traces or far from them. */
  const size = (near: boolean): number => {
    const chosen = pourFace.filter(p => {
      const y = p.points.reduce((s, q) => s + q[1], 0) / 3
      return near ? Math.abs(Math.abs(y) - .375) < .1 : Math.abs(y) > 1.5
    })
    return chosen.reduce((s, p) => s + Math.max(...edges(p.points)), 0) / chosen.length
  }
  assert.ok(size(true) < .25 && size(false) > 2 * size(true), 'pour panels grade from fine near the signal to coarse far away')
})

test('a copper ring that touches its own edge meshes without losing area', () => {
  // AM3352 ground pour island: a via-clearance arc whose apex (vertex 6) lies
  // exactly on the island's outer edge 16-17, so that edge is split before grading.
  const ring: [number, number][] = [[-1.549946, -25.066683688113], [-1.613867112882, -25.048153938437], [-1.61365003549, -25.047405097858], [-1.619080171618, -25.046324976626], [-1.635301339059, -25.035486339059], [-1.646139976626, -25.019265171618], [-1.649946, -25.000131], [-1.646139976626, -24.980996828382], [-1.635301339059, -24.964775660941], [-1.619080171618, -24.953937023374], [-1.599946, -24.950131], [-1.586241964509, -24.952856902141], [-1.586024887118, -24.952108061563], [-1.442037630218, -24.993847757677], [-1.549946, -24.962566777263], [-1.549946, -24.931408660703], [-1.649946, -24.931408660703], [-1.649946, -25.068853339297], [-1.549946, -25.068853339297]]
  const shoelace = Math.abs(ring.reduce((s, p, i) => {
    const q = ring[(i + 1) % ring.length]
    return s + p[0] * q[1] - q[0] * p[1]
  }, 0)) / 2
  for (const h of [.2, .02, .005]) {
    const triangles = meshPolygon([ring], () => h)
    const area = triangles.reduce((s, [a, b, c]) => s + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2, 0)
    assert.ok(Math.abs(area - shoelace) < 1e-9 * Math.max(1, shoelace), `h=${h}: ${area} vs ${shoelace}`)
  }
})
