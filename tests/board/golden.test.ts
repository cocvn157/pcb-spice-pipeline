// Golden: the board module reproduces the pre-module implementation on every repo fixture.
// Oracle: committed digests (tests/board/golden.snapshot.json) recorded from the old flat src/
// while it still existed (see tests/support/golden.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { rootScope } from '../../src/kernel/index.js'
import { type Board, admitBoard, channelGeometry, circuitArtifact, geometryFromCircuitJson, stackupFromCircuitJson, validateCircuitRecords, parseRecord, selectPort, subcircuitTree } from '../../src/board/index.js'
import { goldenDigests, outcome } from '../support/golden.js'
import { boardCases } from './fixtures.js'

const golden = goldenDigests(new URL('./golden.snapshot.json', import.meta.url))

test('geometry.json bytes and Geometry values equal the pre-module geometryFromCircuitJson on every fixture', () => golden('geometry', async see => {
  for (const c of await boardCases()) {
    const before = JSON.stringify(c.circuit)
    // Some unit-test fixtures are hand-written and not schema-valid; admission must reject them as before.
    const admitted = outcome(() => admitBoard(c.circuit))
    see(`${c.name} admission`, 'message' in admitted ? admitted.message : undefined)
    const board = 'message' in admitted ? { circuitJson: c.circuit } as Board : admitBoard(c.circuit), produced = channelGeometry(board, c.modeling, rootScope('board'))
    assert.deepEqual(produced.artifacts.map(a => [a.owner, a.path]), [['board', 'geometry.json']], c.name)
    see(`${c.name} geometry.json`, produced.artifacts[0].body)
    see(`${c.name} geometry`, JSON.stringify(geometryFromCircuitJson(c.circuit, c.modeling)))
    const artifact = circuitArtifact(board, rootScope('board'))
    assert.equal(artifact.path, 'inputs/circuit.json')
    see(`${c.name} inputs/circuit.json`, artifact.body)
    see(`${c.name} stackup`, JSON.stringify(stackupFromCircuitJson(c.circuit)))
    assert.equal(JSON.stringify(c.circuit), before, `${c.name}: input unchanged`)
  }
}))

test('every geometry failure keeps the pre-module code and message', () => golden('failures', async see => {
  const cases = await boardCases()
  const mutations: Array<[string, (c: typeof cases[number]) => void]> = [
    ['no lanes', c => { c.modeling.lanes = [] }],
    ['no profiles', c => { c.modeling.profiles = {} }],
    ['bad reduction', c => { (c.modeling as { reduction: string }).reduction = 'mesh' }],
    ['no plating', c => { c.modeling.viaPlatingMm = undefined }],
    ['stubs kept', c => { c.modeling.omitThroughViaStubs = false }],
    ['side-file stackup', c => { Object.assign(c.modeling, { stackup: [] }) }],
    ['no stackup', c => { c.circuit = c.circuit.filter(e => e.type !== 'pcb_stackup') }],
    ['no pours', c => { c.circuit = c.circuit.filter(e => e.type !== 'pcb_copper_pour') }],
    ['no smtpads', c => { c.circuit = c.circuit.filter(e => e.type !== 'pcb_smtpad') }],
    ['no vias', c => { c.circuit = c.circuit.filter(e => e.type !== 'pcb_via') }],
    ['bad sections', c => { c.modeling.sections = 0 }],
    ['ground return dropped', c => { delete c.modeling.groundReturn }],
  ]
  let failures = 0
  for (const base of cases) for (const [label, mutate] of mutations) {
    const c = structuredClone(base); mutate(c)
    const b = outcome(() => geometryFromCircuitJson(c.circuit, c.modeling))
    see(`${base.name}: ${label}`, b)
    if ('message' in b) failures++
  }
  assert.ok(failures > 50)
}))

test('admission, record parsing, port selection and subcircuit scope match the pre-module functions', () => golden('admission', see => {
  const records = JSON.parse(readFileSync(new URL('../fixtures/am3352.circuit.json', import.meta.url), 'utf8'))
  assert.doesNotThrow(() => validateCircuitRecords(records))
  const bad = [[{ type: 'pcb_plated_hole', pcb_plated_hole_id: 'bad-hole' }], [{ type: 'unknown_record' }], [null], {}, [{ ...records[0], type: 7 }]]
  for (const input of bad) see('validate', outcome(() => validateCircuitRecords(input)))
  for (const record of records.slice(0, 200)) see('parse', outcome(() => parseRecord(record)))
  for (const input of [null, {}, { type: 'nope' }]) see('parse bad', outcome(() => parseRecord(input)))
  for (const s of [{ component: 'U1', port: 'M3' }, { component: 'U3', port: 'E3' }, { component: 'U1', port: 'nope' }, { sourcePortId: 'missing' }, undefined] as const)
    see('selectPort', outcome(() => selectPort(records, s)))
  const tree = subcircuitTree(records)
  const ids = [...new Set(records.map((r: { subcircuit_id?: string }) => r.subcircuit_id))]
  for (const a of ids) for (const b of ids) see(`${a} ${b}`, [tree.within(a, b), tree.common([a, b])])
}))
