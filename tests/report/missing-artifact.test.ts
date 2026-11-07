// generateReport reads files only through paths the result names; a missing one is a typed failure
// (the pre-module report silently rendered `undefined` for the eye CSV).
import test from 'node:test'
import assert from 'node:assert/strict'
import { runPipeline } from '../../src/pipeline/index.js'
import { generateReport } from '../../src/report/index.js'
import type { RunSolver } from '../../src/solver/index.js'
import { inMemoryInput, fixtureSolver } from '../fixtures/in-memory.mjs'

test('a referenced eye CSV missing from result.files fails report_missing_artifact', async () => {
  const result = await runPipeline({ ...inMemoryInput(), runSolver: fixtureSolver as RunSolver } as never)
  const run = result.experiments[0], eye = run.eyes[0], path = `${run.directory}/${eye.directory}/eye-data.csv`
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
