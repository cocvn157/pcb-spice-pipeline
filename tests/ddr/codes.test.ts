// Every code in src/ddr/diagnostics.ts (module rule M3), with today's messages.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Diagnostic } from '../../src/kernel/index.js'
import { resolveDdrAssessments, validateDdrConfig, type DdrAssessmentConfig } from '../../src/ddr/index.js'
import type { SimulationPlan } from '../../src/simulation/index.js'
import type { Geometry } from '../../src/board/index.js'

const config = { name: 'c', dataProbe: 'DQ', strobeProbe: 'DQS', direction: 'write', sampleOffsetSeconds: 0, vrefV: .75,
  thresholds: { vilAcV: .55, vilDcV: .65, vihDcV: .85, vihAcV: .95 }, setupSeconds: 0, holdSeconds: 0,
  minimumStrobeDifferentialV: .5, maximumStrobeIntervalErrorSeconds: 0 } satisfies DdrAssessmentConfig
const plan = { name: 'run', simulationExperimentId: 'run', probes: [], eyes: [], states: [] } as unknown as SimulationPlan
const geometry = { mappings: [] } as unknown as Geometry
const ddr = (code: string, message: string) => (e: unknown) => {
  assert.ok(e instanceof Diagnostic); assert.equal(e.domain, 'ddr')
  assert.deepEqual({ code: e.code, message: e.message }, { code, message: `${code}: ${message}` }); return true
}

test('ddr diagnostics keep codes and messages', () => {
  assert.throws(() => resolveDdrAssessments([plan], geometry, {} as never), ddr('ddr_config', 'modeling.ddrAssessments must be an array'))
  assert.throws(() => validateDdrConfig({ ...config, vrefV: 2 }), { code: 'ddr_config' })
  assert.throws(() => resolveDdrAssessments([plan], geometry, [config]), ddr('ddr_probe', 'run: DQ must select exactly one native voltage probe'))
  assert.throws(() => resolveDdrAssessments([plan], geometry, [config]), { code: 'ddr_probe' })
})
