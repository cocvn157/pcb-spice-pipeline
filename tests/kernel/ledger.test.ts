import test from 'node:test'
import assert from 'node:assert/strict'
import { ArtifactLedger, Diagnostic, diagnostics, rootScope, safeId, sha256 } from '../../src/kernel/index.js'

test('ledger seals sorted keys with jsonFile byte format', () => {
  const root = rootScope('pipeline')
  const files = ArtifactLedger.empty()
    .add([root.text('b.txt', 'B'), root.child('stage-0').json('x.json', { a: 1 })])
    .add([root.json('a.json', [1])]).seal()
  assert.deepEqual(Object.keys(files), ['a.json', 'b.txt', 'stage-0/x.json'])
  assert.equal(files['stage-0/x.json'], '{\n  "a": 1\n}\n')
})

test('a second write to the same path is an artifact_collision naming both owners', () => {
  const ledger = ArtifactLedger.empty().add([rootScope('extraction').text('p', '1')])
  assert.throws(() => ledger.add([rootScope('simulation').text('p', '1')]),
    (e: unknown) => e instanceof Diagnostic && e.code === 'artifact_collision' && /extraction.*simulation/.test(e.message))
})

test('artifact paths reject traversal, absolute and empty segments', () => {
  for (const bad of ['../x', '/x', 'a//b', 'a/./b', 'a\\b', ''])
    assert.throws(() => rootScope('kernel').text(bad, ''), (e: unknown) => e instanceof Diagnostic && e.code === 'artifact_path')
})

test('diagnostics keeps the `${code}: ${text}` message and records the domain', () => {
  const fail = diagnostics('board', ['lanes'] as const)
  assert.throws(() => fail('lanes', 'bad'), (e: unknown) => e instanceof Diagnostic && e.message === 'lanes: bad' && e.domain === 'board')
})

test('safeId and sha256 match the pre-module behaviour', () => {
  assert.equal(safeId('exp_1-a', 'id'), 'exp_1-a')
  assert.throws(() => safeId('a b', 'id'), /simulation_id: Serialized simulation IDs must be safe stable identifiers/)
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
