// Golden: simulation's declarations, electrical sources and experiment deck reproduce the pre-module
// declarations.ts/general-spice.ts. Oracle: committed digests (tests/simulation/golden.snapshot.json)
// recorded from the pre-module flat src/ while it still existed (see tests/support/golden.ts).
// The composed-pipeline goldens moved to tests/pipeline/golden.test.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { geometryFromCircuitJson } from '../../src/board'
import { generalDeclarations, electricalSources, generalSimulationSpice, simulationSpiceOptions, namespaceSpice } from '../../src/simulation'
import { fixture } from '../fixtures/general.mjs'
import { goldenDigests, outcome } from '../support/golden'

const golden = goldenDigests(new URL('./golden.snapshot.json', import.meta.url))

test('golden: generalDeclarations, electrical sources and the experiment deck on the general fixture', () => golden('declarations', see => {
  const { cj, m } = fixture(), g = geometryFromCircuitJson(cj, m)
  const current = generalDeclarations(cj, g, m)
  see('plans', JSON.stringify(current.plans))
  see('models', JSON.stringify(current.models))
  see('mapping', current.nodes.mapping)
  see('ground', current.nodes.groundSourcePortId)
  see('ports', [...current.ports.keys()])
  const electrical = electricalSources(cj, m, current.nodes)
  see('electrical', electrical)
  const compiled = [{ source: '.subckt BUFFER P R\nRTEST P R 1000\n.ends BUFFER\n', spicePinMapping: { P: 'p0', R: 'g0' }, name: 'test' }]
  const extraction = [{ R: [[1, 0], [0, 1]], L: [[1, 0], [0, 1]], C: [[1, 0], [0, 1]] }]
  for (const spice_options of [undefined, { method: 'trap', reltol: '1e-4', vntol: 1e-7 }]) {
    const plan = { ...current.plans[0], experiment: { ...current.plans[0].experiment, spice_options } } as never
    see('deck', generalSimulationSpice(plan, g, m, extraction, compiled, current.nodes, electrical))
  }
  for (const options of [{}, { method: 'trap' }, { abstol: 1e-9 }]) see('options', simulationSpiceOptions(options))
  for (const bad of [{ method: 'euler' }, { gmin: 1 }, { reltol: -1 }]) { assert.throws(() => simulationSpiceOptions(bad)); see('bad options', outcome(() => simulationSpiceOptions(bad))) }
  const source = '.subckt DRV a b\nX1 a b inner\n.ends DRV\n.subckt inner a b\n.ends inner\n'
  see('namespace', namespaceSpice(source, 'IBIS0'))
}))
