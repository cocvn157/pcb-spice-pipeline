// Golden: runPipeline reproduces the pre-module general-pipeline.ts on the canned-solver fixtures:
// artifact paths + bytes, every PipelineResult field, progress messages, and for failures the same
// error code, message and progress up to the failure. Oracle: committed digests
// (tests/pipeline/golden.snapshot.json) recorded from the pre-module flat src/ while it still existed
// (see tests/support/golden.ts). tests/compat/golden.test.ts pins the per-artifact hashes.
import test from 'node:test'
import assert from 'node:assert/strict'
import type { RunSolver, SolverRequest, SolverResult } from '../../src/solver/index.js'
import { runPipeline, type PipelineOptions, type PipelineResult } from '../../src/pipeline/index.js'
import { sha256 } from '../../src/kernel/index.js'
import { inMemoryInput, fixtureSolver } from '../fixtures/in-memory.mjs'
import { goldenDigests, type See } from '../support/golden.js'

const golden = goldenDigests(new URL('./golden.snapshot.json', import.meta.url))
type ComposeInput = PipelineOptions & { modeling: NonNullable<PipelineOptions['modeling']> }
type Solver = (request: SolverRequest) => Promise<SolverResult>
const canned = fixtureSolver as Solver
const withNgspice = (change: (result: SolverResult) => SolverResult): Solver => async request => {
  const result = await canned(request)
  return request.solver === 'ngspice' ? change(result) : result
}
const input = () => inMemoryInput() as unknown as Omit<ComposeInput, 'runSolver'>

async function run(make: () => Omit<ComposeInput, 'runSolver'>, solver: () => Solver) {
  const progress: string[] = []
  try { return { progress, value: await runPipeline({ ...make(), runSolver: solver() as RunSolver, onProgress: m => progress.push(m) }) } }
  catch (e) { return { progress, error: { code: (e as { code?: string }).code, message: (e as Error).message } } }
}
function seeResult(see: See, result: PipelineResult) {
  see('artifact paths', Object.keys(result.files).sort())
  for (const path of Object.keys(result.files).sort()) see(path, result.files[path])
  for (const key of ['experiments', 'simulationResultCircuitJson', 'limitations', 'matrices', 'geometry', 'modeling', 'circuitJson'] as const)
    see(key, JSON.stringify(result[key]))
}

const scenarios: Record<string, [() => Omit<ComposeInput, 'runSolver'>, () => Solver]> = {
  'in-memory': [input, () => canned],
  'string IBIS sources': [() => { const i = input(); i.ibisSources = Object.fromEntries(Object.entries(i.ibisSources).map(([p, b]) => [p, Buffer.from(b as Uint8Array).toString('utf8')])); return i }, () => canned],
  'pinned hash': [() => { const i = input(); i.modeling.ibisModelAssetSha256 = { 'models/test.ibs': sha256(i.ibisSources['models/test.ibs'] as Uint8Array).toUpperCase() }; return i }, () => canned],
  'recovered warnings': [input, () => withNgspice(r => ({ ...r, stderr: 'Warning: singular matrix: check node xchan.s10_0\nWarning: True gmin stepping failed\nNote: Transient op started\n' }))],
  'shifted rerun waveform': [input, () => withNgspice(r => ({ ...r, files: { 'waveform.dat': r.files['waveform.dat'].trim().split('\n').map((l, i) => i ? l.split(' ').map((s, c) => c ? String(Number(s) + 5) : s).join(' ') : l).join('\n') + '\n' } }))],
}

for (const [name, [make, solver]] of Object.entries(scenarios)) test(`golden pipeline: ${name}`, () => golden(`run: ${name}`, async see => {
  const current = await run(make, solver)
  assert.equal(current.error, undefined, JSON.stringify(current.error))
  seeResult(see, current.value!)
  see('progress', current.progress)
}))

test('golden pipeline: rerun on result Circuit JSON', () => golden('rerun', async see => {
  const first = await runPipeline({ ...inMemoryInput(), runSolver: canned } as never)
  const current = await run(() => ({ ...input(), circuitJson: structuredClone(first.simulationResultCircuitJson) as never }), () => canned)
  assert.equal(current.error, undefined, JSON.stringify(current.error))
  seeResult(see, current.value!)
}))

const failures: Record<string, [() => Omit<ComposeInput, 'runSolver'>, () => Solver]> = {
  'ngspice error line': [input, () => withNgspice(() => ({ stdout: 'Error: transient simulation aborted', stderr: '', files: { 'waveform.dat': 'time a b\n0 0 0\n.00001 1 1\n' } }))],
  'missing waveform': [input, () => withNgspice(() => ({ stdout: '', stderr: '', files: {} }))],
  'short duration': [input, () => withNgspice(() => ({ stdout: '', stderr: '', files: { 'waveform.dat': 'time a b\n0 0 0\n.000001 1 1\n' } }))],
  'nonfinite sample': [input, () => withNgspice(() => ({ stdout: '', stderr: '', files: { 'waveform.dat': 'time a b\n0 NaN 0\n.00001 1 1\n' } }))],
  'missing beginning': [input, () => withNgspice(r => { const [h, ...s] = r.files['waveform.dat'].trim().split('\n'); return { ...r, files: { 'waveform.dat': [h, ...s.slice(50)].join('\n') + '\n' } } })],
  'changed IBIS bytes': [() => { const i = input(); i.modeling.ibisModelAssetSha256 = { 'models/test.ibs': sha256(i.ibisSources['models/test.ibs'] as Uint8Array) }; i.ibisSources = { 'models/test.ibs': Buffer.concat([i.ibisSources['models/test.ibs'] as Uint8Array, Buffer.from('| changed\r\n')]) }; return i }, () => canned],
  'malformed hash map': [() => { const i = input(); (i.modeling as { ibisModelAssetSha256: unknown }).ibisModelAssetSha256 = []; return i }, () => canned],
  'missing hash entry': [() => { const i = input(); i.modeling.ibisModelAssetSha256 = {}; return i }, () => canned],
  'missing IBIS bytes': [() => ({ ...input(), ibisSources: {} }), () => canned],
  'unsafe experiment id': [() => { const i = input(); for (const r of i.circuitJson as { simulation_experiment_id?: string }[]) if (r.simulation_experiment_id === 'run') r.simulation_experiment_id = 'run 1'; return i }, () => canned],
  'unsafe model id (after extraction)': [() => { const i = input(); for (const r of i.circuitJson as { type: string; simulation_ibis_model_id?: string }[]) if (r.type === 'simulation_ibis_model' && r.simulation_ibis_model_id === 'model-0') r.simulation_ibis_model_id = 'model 0'; return i }, () => canned],
  'missing supply': [() => { const i = input(); i.modeling.supplies = []; return i }, () => canned],
}
for (const [name, [make, solver]] of Object.entries(failures)) test(`golden failure parity: ${name}`, () => golden(`failure: ${name}`, async see => {
  const current = await run(make, solver)
  assert.ok(current.error, 'pipeline fails')
  see('error', current.error)
  see('progress', current.progress)
}))
