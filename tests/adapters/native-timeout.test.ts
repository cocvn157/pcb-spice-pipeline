// Moved from tests/native-timeout.test.ts; imports repointed to the new modules. Assertions unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeSolver } from '../../src/adapters'
import { nativeDdrTimeout } from '../fixtures/native-ddr-timeout'

const fixture = nativeDdrTimeout()
test('native TSX prepares a three-lane DDR extraction and two eye declarations', async () => {
  const { records, deck } = await fixture
  assert.equal(records.filter(r => r.type === 'simulation_eye_diagram').length, 2)
  assert.equal((deck.match(/^\.external /gm) ?? []).length, 4)
  assert.match(deck, /meshMm=1.5/)
  assert.match(deck, /nhinc=5 nwinc=5/)
})

// Opt-in real FastHenry process; no solver output is mocked or accepted.
// PCB_SPICE_FASTHENRY=/path/to/fasthenry node --import tsx --test tests/native-timeout.test.ts
// A short deadline reproduces adapter behavior without a 15-minute board run.
test('native TSX DDR extraction reports its process deadline', {
  skip: !process.env.PCB_SPICE_FASTHENRY,
}, async () => {
  const { deck } = await fixture
  const solve = createNativeSolver({ tools: { fasthenry: process.env.PCB_SPICE_FASTHENRY }, timeoutMs: 100 })
  await assert.rejects(solve({ solver: 'fasthenry', args: ['-p', 'seg', 'channel.inp'],
    files: { 'channel.inp': deck }, outputFiles: ['Zc.mat'] }), error => {
    console.log((error as Error).message)
    assert.equal((error as { code: string }).code, 'native_timeout')
    assert.match((error as Error).message, /fasthenry.*100 ms/)
    return true
  })
})
