import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { runPipeline, type RunSolver } from '../../src'
import { inMemoryInput, fixtureSolver } from '../fixtures/in-memory.mjs'

// Golden bytes for runPipeline on the repo's canned-solver fixtures (tests/fixtures/in-memory.mjs +
// tests/fixtures/solver.mjs, as used by tests/pipeline-rerun.test.mjs and friends). Snapshots were
// taken against the flat src/ of 2026-11-07; regenerate only deliberately with UPDATE_SNAPSHOTS=1.
const PATHS = new URL('./artifact-paths.json', import.meta.url)
const HASHES = new URL('./artifact-hashes.json', import.meta.url)
const update = process.env.UPDATE_SNAPSHOTS === '1'

type Result = Awaited<ReturnType<typeof runPipeline>>
const bytes = (body: unknown): Buffer => typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body as Uint8Array)
const sha256 = (body: unknown) => createHash('sha256').update(bytes(body)).digest('hex')
const withoutFiles = ({ files, ...rest }: Result) => { void files; return JSON.stringify(rest) }

/** Same transform as tests/pipeline-rerun.test.mjs: rerun on the result Circuit JSON with shifted waveforms. */
const shiftedSolver: RunSolver = async request => {
  const result = await (fixtureSolver as RunSolver)(request)
  if (request.solver === 'ngspice') result.files['waveform.dat'] = result.files['waveform.dat']!.trim().split('\n').map((line: string, index: number) =>
    index === 0 ? line : line.split(' ').map((sample, column) => column === 0 ? sample : String(Number(sample) + 5)).join(' ')).join('\n') + '\n'
  return result
}

const scenarios: Record<string, () => Promise<Result>> = {
  'in-memory': () => runPipeline({ ...inMemoryInput(), runSolver: fixtureSolver as RunSolver } as Parameters<typeof runPipeline>[0]),
  rerun: async () => {
    const input = inMemoryInput()
    const first = await runPipeline({ ...input, runSolver: fixtureSolver as RunSolver } as Parameters<typeof runPipeline>[0])
    return runPipeline({ ...input, circuitJson: first.simulationResultCircuitJson, runSolver: shiftedSolver } as Parameters<typeof runPipeline>[0])
  },
}

const read = (url: URL): Record<string, unknown> => { try { return JSON.parse(readFileSync(url, 'utf8')) } catch { return {} } }
const pathSnapshot = read(PATHS) as Record<string, string[]>
const hashSnapshot = read(HASHES) as Record<string, Record<string, string>>
const nextPaths: Record<string, string[]> = {}, nextHashes: Record<string, Record<string, string>> = {}

for (const [name, run] of Object.entries(scenarios)) {
  test(`golden: ${name}`, async () => {
    const a = await run(), b = await run()

    // (a) byte determinism across two runs
    assert.deepEqual(Object.keys(a.files), Object.keys(b.files), 'same artifact paths in the same order')
    for (const path of Object.keys(a.files)) assert.ok(bytes(a.files[path]).equals(bytes(b.files[path])), `${path} differs between runs`)
    assert.equal(withoutFiles(a), withoutFiles(b), 'result (minus files) differs between runs')

    const paths = Object.keys(a.files).sort()
    const hashes = Object.fromEntries(paths.map(p => [p, sha256(a.files[p])]))
    hashes['<result-without-files>'] = sha256(withoutFiles(a))
    nextPaths[name] = paths; nextHashes[name] = hashes
    if (update) return

    // (b) artifact path snapshot, (c) per-artifact sha256
    assert.ok(pathSnapshot[name], `no snapshot for ${name}; run with UPDATE_SNAPSHOTS=1`)
    assert.deepEqual(paths, pathSnapshot[name])
    const changed = Object.keys(hashSnapshot[name]).filter(p => hashSnapshot[name][p] !== hashes[p])
    assert.deepEqual(changed, [], 'artifacts whose bytes changed')
    assert.deepEqual(Object.keys(hashes).sort(), Object.keys(hashSnapshot[name]).sort())
  })
}

if (update) test.after(() => {
  writeFileSync(PATHS, JSON.stringify(nextPaths, null, 2) + '\n')
  writeFileSync(HASHES, JSON.stringify(nextHashes, null, 2) + '\n')
})
