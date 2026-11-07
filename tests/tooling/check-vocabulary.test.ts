import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  candidates, collectNames, formatReport, isKnown, parseArgs, parseVocabulary, scoreNames, scoreProject, splitWords,
  VocabularyError, type NameEntry, type Vocabulary,
} from '../../scripts/check-vocabulary'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/check-vocabulary.ts')

const DICTIONARY = `# test dictionary
threshold: 85

domain:            # project concepts
  probe: a point where we measure voltage
  lane: one signal path on the board
general:
  - get set build count index value
  - read write   # trailing comment
  - x y
abbreviations:
  mm: millimetre
avoid:
  sensor: probe
  tmp: temporary
`

/** Parses the shared test dictionary, optionally with a different threshold. */
const vocab = (threshold: number = 85): Vocabulary => ({ ...parseVocabulary(DICTIONARY), threshold })

/** Writes files into a fresh temp repo, removed after the test. */
function repo(t: { after(fn: () => void): void }, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'check-vocabulary-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, body] of Object.entries({ 'tools/vocabulary.yaml': DICTIONARY, ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  return root
}

/** The names a snippet declares, as `name` or `name*` when exported. */
const names = (text: string, file: string = 'a.ts'): string[] => collectNames(file, text).map(n => n.exported ? `${n.name}*` : n.name)

/** Asserts that parsing the text fails on the given line with a message matching the pattern. */
function rejects(text: string, line: number, message: RegExp): void {
  assert.throws(() => parseVocabulary(text), (e: unknown) => {
    assert.ok(e instanceof VocabularyError)
    assert.equal(e.line, line)
    assert.match(e.message, message)
    assert.match(e.message, new RegExp(`^line ${line}: `))
    return true
  })
}

test('splitWords: camel, Pascal, snake, SCREAMING, acronyms and digits', () => {
  assert.deepEqual(splitWords('meshPolygon'), ['mesh', 'polygon'])
  assert.deepEqual(splitWords('GroundMesh'), ['ground', 'mesh'])
  assert.deepEqual(splitWords('snake_case_name'), ['snake', 'case', 'name'])
  assert.deepEqual(splitWords('MAX_FILE_LINES'), ['max', 'file', 'lines'])
  assert.deepEqual(splitWords('IBISModel'), ['ibis', 'model'])
  assert.deepEqual(splitWords('toJSON'), ['to', 'json'])
  assert.deepEqual(splitWords('parseHTTPResponse2'), ['parse', 'http', 'response'])
  assert.deepEqual(splitWords('x0'), ['x'])
  assert.deepEqual(splitWords('xMin'), ['x', 'min'])
  assert.deepEqual(splitWords('v2Config'), ['v', 'config'])
  assert.deepEqual(splitWords('__dirname'), ['dirname'])
  assert.deepEqual(splitWords('_'), [])
})

test('candidates: plural, verb, -er and -ly forms', () => {
  /** True when the word normalises to the given stem. */
  const has = (word: string, stem: string): boolean => candidates(word).includes(stem)
  assert.equal(candidates('probe')[0], 'probe', 'the word itself comes first')
  assert.ok(has('properties', 'property'))
  assert.ok(has('boxes', 'box'))
  assert.ok(has('values', 'value'))
  assert.deepEqual(candidates('class'), ['class'], 'no -s rule after "ss"')
  assert.ok(has('added', 'add') && has('used', 'use'))
  assert.ok(has('reading', 'read') && has('using', 'use'))
  assert.ok(has('stopped', 'stop') && has('running', 'run') && has('getter', 'get'))
  assert.ok(has('builder', 'build') && has('writer', 'write'))
  assert.ok(has('strictly', 'strict'))
  assert.ok(has('builders', 'build'), 'a plural of an -er form resolves')
  assert.ok(!candidates('s').includes(''), 'a stem keeps at least one letter')
  assert.equal(new Set(candidates('stopped')).size, candidates('stopped').length, 'deduplicated')
})

test('isKnown: any candidate in domain, general or abbreviations; avoid words never', () => {
  const v = vocab()
  for (const w of ['probes', 'lanes', 'getter', 'counted', 'reading', 'writer', 'mm', 'indexes', 'values', 'x']) assert.ok(isKnown(w, v), w)
  for (const w of ['sensor', 'sensors', 'tmp', 'mesh', 'z']) assert.ok(!isKnown(w, v), w)
})

test('parseVocabulary: sections, comments and threshold', () => {
  const v = vocab()
  assert.equal(v.threshold, 85)
  assert.equal(v.domain.get('probe'), 'a point where we measure voltage')
  assert.deepEqual([...v.general], ['get', 'set', 'build', 'count', 'index', 'value', 'read', 'write', 'x', 'y'])
  assert.equal(v.abbreviations.get('mm'), 'millimetre')
  assert.equal(v.avoid.get('sensor'), 'probe')
  assert.equal(parseVocabulary('general:\n  - a1 b\n').threshold, 85, 'threshold defaults to 85')
  assert.equal(parseVocabulary('threshold: 72.5\n').threshold, 72.5)
  assert.equal(parseVocabulary('').general.size, 0)
})

test('parseVocabulary: invalid files name the line', () => {
  rejects('threshold: high\n', 1, /threshold must be a number/)
  rejects('threshold: 120\n', 1, /threshold must be a number from 0 to 100/)
  rejects('# c\nwords:\n  - a\n', 2, /unknown key "words"/)
  rejects('just text\n', 1, /expected "threshold: N" or a section header/)
  rejects('domain: probe\n', 1, /takes indented entries/)
  rejects('  probe: a point\n', 1, /not inside a section/)
  rejects('domain:\n  probe:\n', 2, /"probe" in domain needs a meaning/)
  rejects('domain:\n  - probe\n', 2, /domain entries look like "word: a meaning"/)
  rejects('abbreviations:\n  mm:   # no expansion\n', 2, /needs its expansion/)
  rejects('avoid:\n  sensor:\n', 2, /needs the word to use instead/)
  rejects('general:\n  get set\n', 2, /general entries are lists of words/)
  rejects('general:\n  - get Set\n', 2, /"Set" is not a valid word/)
  rejects('general:\n  - 9lives\n', 2, /not a valid word/)
  rejects('general:\n  - get\n  - put get\n', 3, /"get" is already listed in general \(line 2\)/)
  rejects('domain:\n  lane: a path\ngeneral:\n  - lane\n', 4, /"lane" is already listed in domain; a word belongs to one section \(line 2\)/)
  rejects('general:\n  - tmp\navoid:\n  tmp: temporary\n', 4, /"tmp" is already listed in general/)
  rejects('general:\n  - a\ngeneral:\n  - b\n', 3, /"general" appears twice/)
  rejects('general:\n\t- a\n', 2, /tabs/)
})

test('collectNames: declarations the project owns are counted', () => {
  const text = `
function makeLane<TValue>(laneWidth: number, { probeName, inner: { depth } }: Opts, [first, , second]: number[]): void {
  const localValue = 1
  let [rowCount] = [2]
  try { void 0 } catch (caught) { void caught }
}
class Board { private readonly traceCount = 0; #hidden = 1; get area(): number { return 1 } method(arg: string): void {} constructor(public owner: string) {} }
interface Shape { width: number; resize(scale: number): void }
type Pair = { left: number; right: number; [key: string]: number }
enum Mode { FastMode }
const named = function innerName() {}
`
  assert.deepEqual(names(text).sort(), [
    'Board', 'FastMode', 'Mode', 'Pair', 'Shape', 'TValue', 'area', 'arg', 'caught', 'depth', 'first', 'hidden', 'innerName',
    'key', 'laneWidth', 'left', 'localValue', 'makeLane', 'method', 'named', 'owner', 'probeName', 'resize', 'right', 'rowCount',
    'scale', 'second', 'traceCount', 'width',
  ])
})

test('collectNames: imports, object keys, string/computed names, 1-character names and _ are skipped', () => {
  const text = `
import { readFile as loadFile, type Thing } from 'node:fs'
import * as path from 'node:path'
import defaultThing from 'x'
const options = { objectKey: 1, nestedKey: { deeperKey: 2 }, methodKey() { return 1 }, get getterKey() { return 1 } }
interface Wire { 'quoted-name': number; [Symbol.iterator](): void; 42: string }
const x = 1
const _ = 2
const __ = 3
for (const [i, entry] of [[1, 2]].entries()) void [i, entry]
export { options as renamedOptions }
`
  assert.deepEqual(names(text), ['options*', 'Wire', 'entry'])
})

test('collectNames: exported marks top-level exported declarations and local export lists', () => {
  const text = `
export function publicThing(innerArg: number): void {}
export const { firstPart, secondPart } = { firstPart: 1, secondPart: 2 }
export interface PublicShape { member: number }
export default class DefaultThing {}
const listed = 1
const hidden = 2
function local(): void { const publicThing = 1 }
export { listed }
export { reexported } from './other'
`
  assert.deepEqual(names(text), ['publicThing*', 'innerArg', 'firstPart*', 'secondPart*', 'PublicShape*', 'member', 'DefaultThing*', 'listed*', 'hidden', 'local'])
})

test('collectNames: .tsx files parse JSX', () => {
  assert.deepEqual(names('export const LanePanel = ({ laneCount }: { laneCount: number }) => <div title="lanes">{laneCount}</div>\n', 'a.tsx'), ['LanePanel*', 'laneCount'])
})

test('scoreNames: dedupe per module, exported names weigh 2, overall is weighted across modules', () => {
  const entries: NameEntry[] = [
    { module: 'board', name: 'laneCount', exported: true },
    { module: 'board', name: 'laneCount', exported: false },
    { module: 'board', name: 'meshSize', exported: false },
    { module: 'board', name: 'probeIndex', exported: false },
    { module: 'solver', name: 'laneCount', exported: false },
    { module: 'solver', name: 'meshGrid', exported: true },
  ]
  const r = scoreNames(entries, vocab())
  assert.equal(r.names, 5, 'laneCount once per module')
  assert.deepEqual(r.modules.map(m => [m.module, m.names, Number(m.score.toFixed(2)), m.belowTarget]), [
    ['board', 3, 75, true], // (2 + 1) / (2 + 1 + 1)
    ['solver', 2, 33.33, true], // 1 / (1 + 2)
  ])
  assert.equal(Number(r.score.toFixed(2)), 57.14) // (3 + 1) / (4 + 3)
  assert.equal(r.pass, false)
})

test('scoreNames: threshold decides pass/fail; modules below target are flagged but do not fail', () => {
  const entries: NameEntry[] = [
    { module: 'alpha', name: 'readValue', exported: true },
    { module: 'alpha', name: 'writeValue', exported: true },
    { module: 'alpha', name: 'buildIndex', exported: true },
    { module: 'beta', name: 'meshCount', exported: false },
  ]
  const at = scoreNames(entries, vocab(6 / 7 * 100))
  assert.equal(at.pass, true, 'a score equal to the threshold passes')
  assert.deepEqual(at.modules.map(m => m.belowTarget), [false, true])
  assert.equal(scoreNames(entries, vocab(90)).pass, false)
  assert.deepEqual(scoreNames([], vocab()), { threshold: 85, score: 100, names: 0, pass: true, modules: [], unknownWords: 0, unknown: [] })
})

test('scoreNames: unknown words ranked by distinct names, then alphabetically, with examples and avoid hints', () => {
  const entries: NameEntry[] = [
    ...['meshPolygon', 'meshMm', 'groundMesh', 'meshes'].map(name => ({ module: 'board', name, exported: false })),
    { module: 'solver', name: 'meshPolygon', exported: false },
    ...['sensorValue', 'sensors'].map(name => ({ module: 'board', name, exported: false })),
    ...['zeta', 'alphaZeta'].map(name => ({ module: 'board', name, exported: false })),
    { module: 'board', name: 'beta', exported: false },
  ]
  const r = scoreNames(entries, vocab())
  assert.deepEqual(r.unknown.map(u => `${u.word} ${u.names}`), [
    'mesh 3', 'zeta 2', 'alpha 1', 'beta 1', 'ground 1', 'meshes 1', 'polygon 1', 'sensor 1', 'sensors 1',
  ], 'meshPolygon counts once although two modules declare it')
  assert.deepEqual(r.unknown[0].examples, ['meshMm', 'groundMesh', 'meshPolygon'], 'shortest names first, at most 3')
  assert.equal(r.unknown.find(u => u.word === 'sensors')?.avoid, 'probe')
  assert.equal(r.unknownWords, 9)
  assert.equal(scoreNames(entries, vocab(), 2).unknown.length, 2, 'the list is capped')

  const text = formatReport(r)
  assert.match(text, /^Vocabulary: 0\.0% of 10 names follow the dictionary \(target 85%\) ✗$/m)
  assert.match(text, /^ {2}board +0\.0% {2}\(9 names\) {2}below target$/m)
  assert.match(text, /^Unknown words \(most used first\):$/m)
  assert.match(text, /^ {2}mesh +3 names {3}e\.g\. meshMm, groundMesh, meshPolygon$/m)
  assert.match(text, /^ {2}sensor +1 name {4}avoid: use "probe"$/m)
})

test('scoreProject: walks src/, assigns modules, skips generated files', t => {
  const root = repo(t, {
    'src/index.ts': 'export const readValue = 1\n',
    'src/board/index.ts': 'export function buildLane(laneIndex: number): number { return laneIndex }\n',
    'src/board/deep/grid.ts': 'export const meshGrid = 1\nconst laneIndex = 2\n',
    'src/board/view.tsx': 'export const LaneView = (): null => null\n',
    'src/board/table.generated.ts': 'export const generatedJunk = 1\n',
    'src/modules.generated.ts': 'export type DomainName = "board"\n',
    'src/board/notes.md': 'notScanned\n',
  })
  const r = scoreProject(root)
  assert.deepEqual(r.modules.map(m => [m.module, m.names]), [['board', 4], ['src', 1]])
  assert.deepEqual(r.unknown.map(u => u.word), ['grid', 'mesh', 'view'])
  // board: buildLane 2/2 + laneIndex 1/1 + meshGrid 0/2 + LaneView 0/2; src: readValue 2/2 → 5/9
  assert.equal(Number(r.score.toFixed(2)), 55.56)
})

test('CLI: exit codes, --json and invalid dictionaries', t => {
  /** Runs the script against a temp repo and returns its exit code and output. */
  const run = (root: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } =>
    spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--root', root, ...args], { encoding: 'utf8' })
  const good = repo(t, { 'src/board/index.ts': 'export const laneCount = 1\nconst probeValue = 2\n' })
  const pass = run(good)
  assert.equal(pass.status, 0, pass.stderr)
  assert.match(pass.stdout, /^Vocabulary: 100\.0% of 2 names follow the dictionary \(target 85%\) ✓/)

  const bad = repo(t, { 'src/board/index.ts': 'export const meshCount = 1\n' })
  const fail = run(bad, '--json')
  assert.equal(fail.status, 1)
  const json = JSON.parse(fail.stdout)
  assert.equal(json.pass, false)
  assert.deepEqual(json.unknown, [{ word: 'mesh', names: 1, examples: ['meshCount'] }])

  const broken = repo(t, { 'tools/vocabulary.yaml': 'general:\n  - Bad\n', 'src/a/index.ts': '' })
  const invalid = run(broken)
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /tools\/vocabulary\.yaml: line 2: "Bad" is not a valid word/)

  assert.throws(() => parseArgs(['--nope'], '.'), /unknown argument "--nope"/)
  assert.deepEqual(parseArgs(['--json', '--root', 'x'], '.'), { json: true, root: 'x' })
})
