// Golden: extraction reproduces the pre-module implementation on every repo fixture.
// Oracle: committed digests (tests/extraction/golden.snapshot.json) recorded from the old flat src/
// while it still existed (see tests/support/golden.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { rootScope, type FileMap } from '../../src/kernel'
import type { RunSolver } from '../../src/solver'
import { geometryFromCircuitJson, type Geometry, type Modeling } from '../../src/board'
import { extractChannel, fastHenryDeck, fasterCapDeck, copperFasterCapDeck, channelSpice } from '../../src/extraction'
import { fixtureSolver } from '../fixtures/solver.mjs'
import { boardCases } from '../board/fixtures'
import { goldenDigests } from '../support/golden'
import { consistentSolver } from './solvers'

const golden = goldenDigests(new URL('./golden.snapshot.json', import.meta.url))
const cases = (await boardCases()).flatMap(c => {
  try { return [{ ...c, geometry: geometryFromCircuitJson(c.circuit, c.modeling) }] } catch { return [] }
})

test('FastHenry and FasterCap decks equal the pre-module decks for every fixture cell, coarse and refined', () => golden('decks', see => {
  assert.ok(cases.length >= 9)
  for (const { name, geometry, modeling } of cases) for (const cell of geometry.cells) {
    const e = modeling.extraction
    for (const settings of [e, { ...e, minimumHz: e.modelHz, maximumHz: e.modelHz, filaments: e.refinementFilaments, groundMeshMm: e.groundMeshMm === undefined ? undefined : e.groundMeshMm / 2 }]) {
      see(`${name} stage ${cell.stage} fasthenry`, fastHenryDeck(cell, settings))
      see(`${name} stage ${cell.stage} fastercap`, fasterCapDeck(cell, settings))
    }
    if (cell.routedCopper) see(`${name} unshaped`, copperFasterCapDeck(cell))
  }
}))

async function run(geometry: Geometry, modeling: Modeling, solver: () => RunSolver) {
  const progress: string[] = []
  let result: { value?: string; error?: { code?: string; message: string } }, files: FileMap = {}
  try {
    const produced = await extractChannel(geometry, modeling, rootScope('extraction'), { runSolver: solver(), progress: m => progress.push(m) })
    assert.equal(new Set(produced.artifacts.map(a => a.path)).size, produced.artifacts.length, 'one artifact per path')
    assert.ok(produced.artifacts.every(a => a.owner === 'extraction'))
    files = Object.fromEntries(produced.artifacts.map(a => [a.path, a.body]))
    assert.equal(produced.value.spice, files['channel.cir'])
    result = { value: JSON.stringify(produced.value.matrices) }
  } catch (e) { result = { error: { code: (e as { code?: string }).code, message: (e as Error).message } } }
  return { result, files, progress }
}

test('extractChannel artifacts (paths + bytes), matrices and progress equal the pre-module pipeline on every fixture', () => golden('extract', async see => {
  let succeeded = 0
  for (const { name, geometry, modeling } of cases) {
    const r = await run(geometry, modeling, () => consistentSolver(geometry, modeling))
    assert.ok(r.result.value, `${name}: canned solver passes every check (${r.result.error?.message})`)
    see(name, r)
    succeeded++
  }
  assert.ok(succeeded >= 9)
  // The repo's in-memory pipeline solver on the straight board (as tests/in-memory uses it).
  const straight = cases.find(c => c.name === 'straight')!
  const r = await run(straight.geometry, straight.modeling, () => fixtureSolver as RunSolver)
  assert.ok(r.result.value)
  see('straight fixture solver', r)
  assert.equal(channelSpice(JSON.parse(r.result.value!), straight.modeling.sections), r.files['channel.cir'])
}))

test('extraction failures keep the pre-module code and message', () => golden('failures', async see => {
  const solvers: Array<[string, (g: Geometry, m: Modeling) => RunSolver]> = [
    ['fixture solver', () => fixtureSolver as RunSolver],
    ['nonconverged', (g, m) => { const s = consistentSolver(g, m); return async q => ({ ...await s(q), stderr: 'Warning: Convergence not reached' }) }],
    ['exit 1', () => async () => ({ stdout: '', stderr: 'boom', files: {}, exitCode: 1 })],
    ['missing output', () => async () => ({ stdout: '', stderr: '', files: {} })],
    ['no cap tolerance', (g, m) => { const s = consistentSolver(g, m); return async q => { const out = await s(q); return q.solver === 'fastercap' ? { ...out, stdout: out.stdout.replace(/Weighted.*\n/, '') } : out } }],
    ['bad modelHz', (g, m) => consistentSolver(g, { ...m, extraction: { ...m.extraction, modelHz: m.extraction.modelHz * 2 } })],
  ]
  for (const { name, geometry, modeling } of cases) for (const [label, solver] of solvers)
    see(`${name}: ${label}`, (await run(geometry, modeling, () => solver(geometry, modeling))).result)
}))
