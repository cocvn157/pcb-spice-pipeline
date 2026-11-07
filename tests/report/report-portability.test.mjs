// Moved from tests/report-portability.test.mjs; imports repointed to the new modules. Assertions unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import {runPipeline,generateReport,transmittedBits} from '../../src/index.js'
import {inMemoryInput,fixtureSolver} from '../fixtures/in-memory.mjs'

test('public utilities and report generation work without the Node Buffer global',async()=>{
  const result=await runPipeline({...inMemoryInput(),runSolver:fixtureSolver})
  const buffer=globalThis.Buffer
  try {
    globalThis.Buffer=undefined
    assert.equal(transmittedBits([0,1,1]),'011')
    assert.match(generateReport(result)['results.html'],/simulation-data/)
  } finally {globalThis.Buffer=buffer}
})
