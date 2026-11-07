import test from 'node:test'
import assert from 'node:assert/strict'
import { subcircuitTree } from '../../src/board'

/** A source_group record; with `subcircuit` it also owns a subcircuit named `sub_<id>`. */
const group = (id: string, parent?: string, subcircuit: boolean = true): { type: string; source_group_id: string; parent_source_group_id: string | undefined; subcircuit_id?: string } => ({ type: 'source_group', source_group_id: id,
  parent_source_group_id: parent, ...(subcircuit ? { subcircuit_id: `sub_${id}` } : {}) })

test('nested subcircuits resolve containment and nearest common ancestors', () => {
  // board > (cpu, plain > ram); "plain" is a grouping without its own subcircuit.
  const tree = subcircuitTree([group('board'), group('cpu', 'board'), group('plain', 'board', false), group('ram', 'plain')])
  assert.equal(tree.common(['sub_cpu', 'sub_ram']), 'sub_board')
  assert.equal(tree.common(['sub_ram', 'sub_ram']), 'sub_ram')
  assert.equal(tree.common(['sub_ram', 'sub_board']), 'sub_board')
  assert.equal(tree.common(['sub_ram', undefined]), undefined)
  assert.ok(tree.within('sub_ram', 'sub_board'))
  assert.ok(tree.within('sub_ram', 'sub_ram'))
  assert.ok(tree.within('sub_ram', null), 'the unscoped root contains every subcircuit')
  assert.ok(!tree.within('sub_board', 'sub_ram'))
  assert.ok(!tree.within('sub_cpu', 'sub_ram'))
  assert.ok(!tree.within(undefined, 'sub_board'))
})

test('unrelated top-level subcircuits only share the unscoped root', () => {
  const tree = subcircuitTree([group('a'), group('b')])
  assert.equal(tree.common(['sub_a', 'sub_b']), undefined)
})
