// Copied from tests/native-channel.test.ts: the circuitNodes test tests/board/native-channel.test.ts left to simulation.
import test from 'node:test'
import assert from 'node:assert/strict'
import { geometryFromCircuitJson } from '../../src/board/index.js'
import { circuitNodes } from '../../src/simulation/index.js'
import { nativeChannel, modeling } from '../fixtures/native-channel.js'

test('component net bindings preserve distinct channel endpoints', async () => {
  const circuit = await nativeChannel({ netBindings: true })
  const geometry = geometryFromCircuitJson(circuit, modeling)
  const nodes = circuitNodes(circuit, geometry, modeling), lane = geometry.mappings[0]
  assert.notEqual(nodes.node(lane.from), nodes.node(lane.to))
})
