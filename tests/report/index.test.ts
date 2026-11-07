// The report module's public surface, generateReport.
// It reads files only through paths the result names; a missing one is a typed failure
// (the pre-module report silently rendered `undefined` for the eye CSV).
// The portability test moved from tests/report-portability.test.mjs; assertions unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runPipeline } from '../../src/pipeline'
import { generateReport } from '../../src/report'
import { transmittedBits } from '../../src'
import type { RunSolver } from '../../src/solver'
import { inMemoryInput, fixtureSolver } from '../fixtures/in-memory.mjs'

test('a referenced eye CSV missing from result.files fails report_missing_artifact', async () => {
  const result = await runPipeline({ ...inMemoryInput(), runSolver: fixtureSolver as RunSolver } as never)
  const run = result.experiments[0]
  const eye = run.eyes[0]
  const path = `${run.directory}/${eye.directory}/eye-data.csv`
  assert.ok(Object.hasOwn(result.files, path))
  assert.ok(generateReport(result)['results.html'].startsWith('<!doctype html>'))
  const files = { ...result.files }
  delete files[path]
  assert.throws(() => generateReport({ ...result, files }), (error: { code?: string; domain?: string; message: string; subjects?: unknown }) => {
    assert.equal(error.code, 'report_missing_artifact')
    assert.equal(error.domain, 'report')
    assert.equal(error.message, `report_missing_artifact: ${path}: the result names this artifact but result.files does not contain it`)
    assert.deepEqual(error.subjects, [{ kind: 'artifact', id: path }])
    return true
  })
})

test('public utilities and report generation work without the Node Buffer global', async () => {
  const result = await runPipeline({ ...inMemoryInput(), runSolver: fixtureSolver as RunSolver } as never)
  const buffer = globalThis.Buffer
  try {
    (globalThis as { Buffer?: typeof Buffer }).Buffer = undefined
    assert.equal(transmittedBits([0, 1, 1]), '011')
    assert.match(generateReport(result)['results.html'], /simulation-data/)
  } finally { globalThis.Buffer = buffer }
})
