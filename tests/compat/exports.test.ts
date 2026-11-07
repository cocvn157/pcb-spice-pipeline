import test from 'node:test'
import assert from 'node:assert/strict'
import * as root from '../../src/index.js'
import * as node from '../../src/adapters/index.js'

// Pinned against the flat src/ of 2026-11-07. The switch-over must keep these runtime names exactly.
// (Type-only exports are pinned by `pnpm typecheck` of the consumer tests, not here.)
const ROOT = ['assessDdr', 'generateReport', 'modelingFromCircuitJson', 'resolveDdrAssessments', 'runPipeline', 'stackupFromCircuitJson', 'transmittedBits']
const NODE = ['createNativeSolver', 'loadIbisSources', 'writePipelineOutput']

test('root entry exports exactly today\'s runtime names, all functions', () => {
  assert.deepEqual(Object.keys(root).sort(), ROOT)
  for (const name of ROOT) assert.equal(typeof (root as Record<string, unknown>)[name], 'function', name)
})

test('/node entry exports exactly today\'s runtime names, all functions', () => {
  assert.deepEqual(Object.keys(node).sort(), NODE)
  for (const name of NODE) assert.equal(typeof (node as Record<string, unknown>)[name], 'function', name)
})
