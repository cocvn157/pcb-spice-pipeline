import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { CircuitJson } from 'circuit-json'
import { stackupFromCircuitJson, geometryFromCircuitJson } from '../../src/board'
import { fastHenryDeck } from '../../src/extraction'

/** A 4-layer board with the JLC04161H-3313 stackup record, built fresh for each test. */
const fixture = (): CircuitJson => [
  { type: 'pcb_board', pcb_board_id: 'pcb_board_0', num_layers: 4, width: 10, height: 10, center: { x: 0, y: 0 }, thickness: 1.6 },
  JSON.parse(readFileSync(new URL('../fixtures/jlc-stackup.json', import.meta.url), 'utf8')),
]

test('JLC04161H-3313 reproduces board-construction copper and dielectric ranges exactly', () => {
  const result = stackupFromCircuitJson(fixture())
  assert.deepEqual(result.copperLayers.map(({conductivitySm, ...layer}) => layer), [
    {name: 'bottom', zMinMm: -.035, zMaxMm: 0},
    {name: 'inner2', zMinMm: .0994, zMaxMm: .1146},
    {name: 'inner1', zMinMm: 1.3796, zMaxMm: 1.3948},
    {name: 'top', zMinMm: 1.4942, zMaxMm: 1.5292},
  ])
  assert.deepEqual(result.dielectrics, [
    {material: '3313 RC57%', zMinMm: 0, zMaxMm: .0994, relativePermittivity: 4.1},
    {material: 'NP-155F', zMinMm: .1146, zMaxMm: 1.3796, relativePermittivity: 4.42},
    {material: '3313 RC57%', zMinMm: 1.3948, zMaxMm: 1.4942, relativePermittivity: 4.1},
  ])
  assert.equal(result.relativePermittivity, (.0994 * 4.1 * 2 + 1.265 * 4.42) / (.0994 * 2 + 1.265))
})

test('missing Circuit JSON stackup fails early with the board template instruction', () => {
  assert.throws(() => geometryFromCircuitJson(fixture().slice(0, 1), {} as never), {
    message: 'Board pcb_board_0 has no pcb_stackup. Set fabricatorPreset (e.g. "jlcpcb_standard") on <board> so the JLC stackup template is resolved into Circuit JSON.',
  })
})

test('conductivity defaults to annealed copper, preserves explicit per-layer values and reaches the solver', () => {
  const circuit = fixture()
  const stackup = circuit[1]
  if (stackup.type !== 'pcb_stackup' || stackup.layers[0].layer_type !== 'copper') throw Error('fixture')
  stackup.layers[0].electrical_conductivity_s_per_m = 3e7
  assert.deepEqual(stackupFromCircuitJson(circuit).copperLayers.map(layer => layer.conductivitySm), [5.8e7, 5.8e7, 5.8e7, 3e7])
  const small = JSON.parse(readFileSync(new URL('../fixtures/straight.circuit.json', import.meta.url), 'utf8'))
  const modeling = JSON.parse(readFileSync(new URL('../fixtures/straight.modeling.json', import.meta.url), 'utf8'))
  small.find((record: {type: string}) => record.type === 'pcb_stackup').layers[0].electrical_conductivity_s_per_m = 3e7
  const geometry = geometryFromCircuitJson(small, modeling)
  assert.equal(geometry.cells[0].conductors[0].conductivitySm, 3e7)
  assert.match(fastHenryDeck(geometry.cells[0], modeling.extraction), /sigma=30000000/)
})

test('stackup must reference the actual board and match its copper count', () => {
  const circuit = fixture()
  const stackup = circuit[1]
  if (stackup.type !== 'pcb_stackup') throw Error('fixture')
  stackup.pcb_board_id = 'missing'
  assert.throws(() => stackupFromCircuitJson(circuit), /referenced by missing/)
  stackup.pcb_board_id = 'pcb_board_0'
  stackup.layers = stackup.layers.filter(layer => layer.layer_type !== 'copper' || !layer.layer.startsWith('inner'))
  assert.throws(() => stackupFromCircuitJson(circuit), /match pcb_board.num_layers/)
})

test('side-file board construction is rejected instead of competing with Circuit JSON', () => {
  const circuit = JSON.parse(readFileSync(new URL('../fixtures/straight.circuit.json', import.meta.url), 'utf8'))
  const modeling = JSON.parse(readFileSync(new URL('../fixtures/straight.modeling.json', import.meta.url), 'utf8'))
  for (const key of ['stackup', 'conductivitySm', 'copperLayers'])
    assert.throws(() => geometryFromCircuitJson(circuit, {...modeling, [key]: []}), new RegExp(`Remove modeling\\.${key}`))
})
