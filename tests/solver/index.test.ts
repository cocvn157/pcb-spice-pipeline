import test from 'node:test'
import assert from 'node:assert/strict'
import { invoke, type SolverContext, type SolverResult, type SolverRequest } from '../../src/solver'
import { rootScope } from '../../src/kernel'

/** Solver context whose fake solver hands back `result` unchanged, so tests can feed malformed results to invoke. */
const ctx = (result: SolverResult | unknown): SolverContext => ({ runSolver: async () => result as SolverResult, progress: () => {} })
const request = { solver: 'ngspice' as const, files: { 'simulation.cir': 'deck' }, args: ['-b'], outputFiles: ['waveform.dat'] }

test('accepted run records inputs, outputs, logs and request under the scope', async () => {
  const { value, artifacts } = await invoke(ctx({ stdout: 'o', stderr: 'e', files: { 'waveform.dat': 'w' } }), rootScope('simulation').child('experiments', 'x'), request)
  assert.equal(value.outputs['waveform.dat'], 'w')
  assert.deepEqual(artifacts.map(a => a.path), ['experiments/x/simulation.cir', 'experiments/x/waveform.dat',
    'experiments/x/ngspice.stdout.log', 'experiments/x/ngspice.stderr.log', 'experiments/x/ngspice.request.json'])
})

test('protocol failures keep today\'s codes and messages', async () => {
  const s = rootScope('simulation')
  await assert.rejects(invoke(ctx({ stdout: 1 }), s, request), /^Error: solver_result: ngspice: expected stdout, stderr and files$|solver_result: ngspice: expected stdout, stderr and files/)
  await assert.rejects(invoke(ctx({ stdout: 'o', stderr: 'e', files: {}, exitCode: 2 }), s, request), /native_solver: ngspice: exited 2\no\ne/)
  await assert.rejects(invoke(ctx({ stdout: 'o', stderr: 'e', files: {} }), s, request), /native_output: ngspice: missing waveform.dat/)
})

test('the callee cannot mutate the caller\'s request', async () => {
  /** Fake solver that tampers with the request it receives, to prove invoke passed it a copy. */
  const runSolver = async (r: SolverRequest): Promise<SolverResult> => {
    r.files['simulation.cir'] = 'mutated'
    r.args.push('x')
    return { stdout: '', stderr: '', files: { 'waveform.dat': '' } }
  }
  await invoke({ runSolver, progress: () => {} }, rootScope('simulation'), request)
  assert.equal(request.files['simulation.cir'], 'deck')
  assert.deepEqual(request.args, ['-b'])
})
