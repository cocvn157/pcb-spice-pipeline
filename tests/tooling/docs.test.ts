import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

const root = join(import.meta.dirname, '..', '..')
const markdownFiles = (): string[] => {
  const files = ['README.md', 'CLAUDE.md'].filter(f => existsSync(join(root, f)))
  const walk = (dir: string): void => {
    for (const name of readdirSync(join(root, dir))) {
      const rel = join(dir, name)
      if (statSync(join(root, rel)).isDirectory()) walk(rel)
      else if (extname(name) === '.md') files.push(rel)
    }
  }
  if (existsSync(join(root, 'docs'))) walk('docs')
  return files
}
const mermaidBlocks = (md: string): string[] => [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(m => m[1].trim())

test('README keeps the required opening sections in order', () => {
  const headings = readFileSync(join(root, 'README.md'), 'utf8').split('\n').filter(l => l.startsWith('## '))
  assert.deepEqual(headings.slice(0, 3), ['## What is it?', '## How to use it?', '## General workflow'])
})

test('README general workflow has a workflow and a state machine diagram', () => {
  const md = readFileSync(join(root, 'README.md'), 'utf8')
  const section = md.slice(md.indexOf('## General workflow'), md.indexOf('\n## ', md.indexOf('## General workflow') + 1))
  const kinds = mermaidBlocks(section).map(b => b.split(/\s/)[0])
  assert.ok(kinds.includes('flowchart'), 'needs a flowchart (workflow)')
  assert.ok(kinds.includes('stateDiagram-v2'), 'needs a stateDiagram-v2 (state machine)')
})

test('every Mermaid diagram is a workflow or a state machine', () => {
  for (const file of markdownFiles())
    for (const block of mermaidBlocks(readFileSync(join(root, file), 'utf8')))
      assert.match(block, /^(flowchart|stateDiagram-v2)\b/, `${file}: diagram must be flowchart or stateDiagram-v2`)
})

test('no diagram images in docs or markdown', () => {
  for (const file of markdownFiles())
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /!\[[^\]]*\]\([^)]*\.(png|svg|jpe?g|gif|webp)(\?[^)]*)?\)/i, `${file}: use a mermaid block instead of an image`)
  const images = (dir: string): string[] => !existsSync(join(root, dir)) ? [] : readdirSync(join(root, dir)).flatMap(n =>
    statSync(join(root, dir, n)).isDirectory() ? images(join(dir, n)) : /\.(png|svg|jpe?g|gif|webp)$/i.test(n) ? [join(dir, n)] : [])
  assert.deepEqual(images('docs'), [])
})
