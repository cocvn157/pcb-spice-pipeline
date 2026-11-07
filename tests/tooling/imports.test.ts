import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// House style: relative imports in TypeScript have no extension (`from './stages'`,
// `from '../board'`). scripts/fix-dist-imports.mjs adds `.js` back in dist/ for Node.
const root = join(import.meta.dirname, '..', '..')
/** Every .ts/.tsx file under this directory, recursively, skipping node_modules. */
const tsFiles = (dir: string): string[] => readdirSync(join(root, dir)).flatMap(name => {
  const rel = join(dir, name)
  if (statSync(join(root, rel)).isDirectory()) return name === 'node_modules' ? [] : tsFiles(rel)
  return /\.tsx?$/.test(name) ? [rel] : []
})

test('relative TypeScript imports carry no .js/.ts extension', () => {
  const spec = /(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"\n]*\.(?:js|ts|tsx))['"]/g
  const bad = ['src', 'tests', 'scripts', 'examples'].flatMap(tsFiles).flatMap(file =>
    [...readFileSync(join(root, file), 'utf8').matchAll(spec)].map(m => `${relative(root, join(root, file))}: '${m[1]}'`))
  assert.deepEqual(bad, [])
})
