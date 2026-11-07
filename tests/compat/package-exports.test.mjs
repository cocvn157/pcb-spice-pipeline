// Moved from tests/package-exports.test.mjs; imports repointed to the new modules. Assertions unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ImportedBoard is an internal test helper; tsci projects declare simulations
// in native TSX. Keep it out of the public package surface.
test('package exports do not expose the internal ImportedBoard bridge', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './node'])
  for (const entry of Object.values(manifest.exports)) assert.doesNotMatch(JSON.stringify(entry), /tsx/)
})
