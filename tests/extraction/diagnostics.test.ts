// One minimal trigger per extraction diagnostic code not already exercised by the ported suites.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { rootScope, type Produced } from '../../src/kernel'
import type { SolverRequest, SolverResult } from '../../src/solver'
import { geometryFromCircuitJson, type Modeling } from '../../src/board'
import { extractChannel, parseFastHenry, parseFasterCap, validateMatrix, meshPolygon, channelSpice, type ExtractedChannel } from '../../src/extraction'
import { consistentSolver, type Tweak } from './solvers'

/** Loads a JSON fixture from tests/fixtures; the caller's declared type says what it holds. */
const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'))
const modeling: Modeling = read('straight.modeling.json')
const geometry = geometryFromCircuitJson(read('straight.circuit.json'), modeling)
/** Asserts that f throws a diagnostic with this code (and, if given, a matching message). */
const rejects = (f: () => unknown, code: string, message?: RegExp): void => assert.throws(f, (e: { code?: string; message: string }) => {
  assert.equal(e.code, code)
  if (message) assert.match(e.message, message)
  return true
})
/** Runs extraction on the straight board against the canned solver, perturbed by tweak. */
const extract = (tweak: Tweak, m: Modeling = modeling): Promise<Produced<ExtractedChannel>> => extractChannel(geometry, m, rootScope('extraction'), { runSolver: consistentSolver(geometry, m, tweak), progress: () => {} })
// An object method so check-modules M3 sees `.rejects(..., 'code', ...)` as an assertion.
const solverRun = { rejects: async (tweak: Tweak, code: string, message: RegExp, m?: Modeling) => assert.rejects(extract(tweak, m), (e: { code?: string; message: string; subjects?: unknown }) => {
  assert.equal(e.code, code)
  assert.match(e.message, message)
  return true
}) }

test('the canned solver passes every check on the straight board', async () => {
  const { value } = await extract({})
  assert.equal(value.matrices.length, 1)
  assert.match(value.spice, /^\.subckt CHANNEL IN0 IN1 OUT0 OUT1 REF$/m)
})

test('parsers reject malformed native output', () => {
  rejects(() => parseFastHenry(''), 'fasthenry_output', /No frequency matrices in Zc\.mat/)
  rejects(() => parseFastHenry('Impedance matrix for frequency = 1 5 x 5\n'), 'fasthenry_ports', /One to three signals/)
  rejects(() => parseFasterCap(''), 'fastercap_output', /No 3D capacitance matrix/)
  rejects(() => parseFasterCap('Capacitance matrix is:\nDimension 5 x 5\ng 1\n'), 'fastercap_ports', /Expected 2x2, 3x3 or 4x4/)
  rejects(() => validateMatrix([[1, 2]], 'X'), 'matrix_format', /X: finite square matrix required/)
  rejects(() => validateMatrix([[0]], 'X'), 'matrix_zero', /X/)
  rejects(() => meshPolygon([[[0, 0], [1, 0], [1, 1]]], () => 0), 'copper_surface', /panel size must be finite and positive/)
})

test('native results that fail a physical check never produce matrices', async () => {
  await solverRun.rejects({ noRows: true }, 'matrix_order', /FastHenry external port ordering disagrees/)
  await solverRun.rejects({ coarseHz: [modeling.extraction.minimumHz] }, 'model_frequency', /modelHz must be one executed FastHenry sample frequency/)
  await solverRun.rejects({ rScale: [1, 1.5] }, 'mesh_convergence', /Stage 0 R refinement residual .* > 0\.05; increase filaments and refinementFilaments explicitly/)
  await solverRun.rejects({ rScale: [2, 2] }, 'analytic_resistance', /DC geometry check failed/)
  await solverRun.rejects({ lowMutualR: .01 }, 'analytic_return', /Shared-return DC resistance mismatch/)
  await solverRun.rejects({}, 'cap_convergence', /FasterCap did not report converged automatic refinement/, { ...modeling, extraction: { ...modeling.extraction, capTolerance: 1e-4 } })
})

test('underflowing capacitance fails the neutral charge/energy reconstruction', async () => {
  const base = consistentSolver(geometry, modeling)
  /** The canned solver, but with every FasterCap capacitance shrunk until it underflows. */
  const tiny: typeof base = async (request: SolverRequest): Promise<SolverResult> => {
    const out = await base(request)
    return request.solver === 'fastercap' ? { ...out, stdout: out.stdout.replace(/e-12\b/g, 'e-170') } : out
  }
  await assert.rejects(extractChannel(geometry, modeling, rootScope('extraction'), { runSolver: tiny, progress: () => {} }),
    { code: 'reference_energy', message: 'reference_energy: Neutral finite-return charge/energy reconstruction failed' })
})

test('channel.cir needs 1..128 sections; a hole outside its outline is not a meshable copper ring', () => {
  const stage = { R: [[1, 0], [0, 1]], L: [[1, 0], [0, 1]], C: [[1, 0], [0, 1]] }
  for (const sections of [0, 129, 1.5]) rejects(() => channelSpice([stage], sections), 'sections', /sections must be an integer 1\.\.128/)
  rejects(() => meshPolygon([[[0, 0], [2, 0], [2, 2], [0, 2]], [[2, 2], [3, 2], [3, 3]]], () => 1), 'ground_geometry', /Copper ring edge is missing from its triangulation/)
})
