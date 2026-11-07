// Moved from tests/solver-exit.test.mjs; imports repointed to the new modules. Assertions unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import {runPipeline} from '../../src/index.js'
import {inMemoryInput,fixtureSolver} from '../fixtures/in-memory.mjs'

test('explicit nonzero solver exits reject even when the returned matrices look valid',async()=>{
  await assert.rejects(runPipeline({...inMemoryInput(),runSolver:async request=>({
    ...await fixtureSolver(request),exitCode:23,
  })}),error=>error.code==='native_solver'&&error.message.includes('exited 23'))
})
