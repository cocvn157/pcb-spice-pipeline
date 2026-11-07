/**
 * pnpm check:modules [--write]
 * The module list is the filesystem. Nothing here enumerates modules by name.
 *
 * A module is a directory src/<dir>/ containing index.ts.
 * Fails the build (exit 1, one line per violation) unless, for EVERY module:
 *   M1  exactly one `diagnostics('<dir>', [ ...literal strings ])` call. Codes may be shared across
 *       modules (today 10 codes have raisers in >1 file); the generated DiagnosticCode union is the
 *       de-duplicated set and tests/compat/codes.test.ts asserts it EQUALS today's raised-code set
 *   M2  tests/<dir>/ exists with >= 1 test file (every module is tested; no list of modules anywhere)
 *   M3  every code in the module's diagnostics tuple is raised by at least one test in tests/<dir>/
 *       (grep for the literal in an assertion: rejects(..., {code:'x'})) — no declared-but-untested failure
 *   EX  tools/exemptions.json may waive M1-M3 for a module with an ISO expiry date; expired => fail (migration)
 * and for src/ as a whole:
 *   S1  no directory under src/ without index.ts (no unowned code); src/*.ts only index.ts + modules.generated.ts
 *   S2  a cross-module import must target the module folder `../<other>` (internals unreachable)
 *   S3  the module import graph is acyclic (derived from imports; there is no declared layer list)
 *   S4  `node:*` and fs/child_process imports appear only in src/adapters/**
 *   S5  src/index.ts imports only `./<module>` and ./modules.generated
 *   S6  src/modules.generated.ts equals the generated DomainName + DiagnosticCode unions (--write regenerates)
 *
 * Migration (tools/exemptions.json, see ARCHITECTURE.md "Staged migration"):
 *   { "legacy":  { "expires": "YYYY-MM-DD", "paths": ["src/old.ts", "src/legacy/", ...] },
 *     "modules": { "<dir>": { "expires": "YYYY-MM-DD", "waive": ["M2", "M3"] } } }
 *   A legacy path (file, or directory with a trailing '/') is exempt from S1 and S4, may be imported by
 *   src/index.ts (S5), and is never a module. A module waiver suppresses the listed M-rules. Entries are
 *   valid through their expiry day (UTC); after it they fail EX and stop waiving anything.
 */
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export interface ModuleInfo { dir: string; root: string; tests: string }
export type Rule = `M${1|2|3}` | 'EX' | `S${1|2|3|4|5|6}`
export interface Violation { rule: Rule; module?: string; message: string }

export interface Exemptions {
  legacy?: { expires: string; paths: string[] }
  modules?: Record<string, { expires: string; waive: string[] }>
}
export interface CheckOptions {
  /** Today's date as YYYY-MM-DD (UTC). Defaults to the current date. */
  today?: string
  exemptions?: Exemptions
}

const SOURCE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/
const TEST = /\.test\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/
const toPosix = (p: string) => p.split(sep).join('/')
const todayUtc = () => new Date().toISOString().slice(0, 10)
const isoDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))

/** Single source: every src/<dir>/index.ts. Tests live in the sibling tests/<dir>/. */
export function discoverModules(src: string, tests = join(dirname(src), 'tests')): ModuleInfo[] {
  return readdirSync(src, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(src, d.name, 'index.ts')))
    .map(d => ({ dir: d.name, root: join(src, d.name), tests: join(tests, d.name) }))
    .sort((a, b) => a.dir.localeCompare(b.dir))
}

function walk(dir: string, keep: RegExp): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const path = join(dir, d.name)
    return d.isDirectory() ? walk(path, keep) : keep.test(d.name) ? [path] : []
  }).sort()
}
const parse = (file: string) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)

function visit(node: ts.Node, fn: (n: ts.Node) => void) { fn(node); ts.forEachChild(node, c => visit(c, fn)) }

/** `x as const`, `x satisfies T`, `(x)` → x */
function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression
  return e
}

export interface DiagnosticsCall { file: string; domain?: string; codes?: string[]; problem?: string }

/** Every `diagnostics(...)` call in a module's sources, with its literal tuple parsed from the AST. */
export function findDiagnosticsCalls(root: string): DiagnosticsCall[] {
  const calls: DiagnosticsCall[] = []
  for (const file of walk(root, SOURCE)) visit(parse(file), n => {
    if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== 'diagnostics') return
    const [d, list] = n.arguments, call: DiagnosticsCall = { file }
    if (d && ts.isStringLiteralLike(d)) call.domain = d.text
    const arr = list && unwrap(list)
    if (arr && ts.isArrayLiteralExpression(arr) && arr.elements.every(ts.isStringLiteralLike))
      call.codes = arr.elements.map(e => (e as ts.StringLiteralLike).text)
    if (call.domain === undefined) call.problem = 'first argument must be a string literal domain'
    else if (!call.codes) call.problem = 'second argument must be an array literal of string literals'
    calls.push(call)
  })
  return calls
}

function loadExemptions(path: string): { value: Exemptions; problem?: string } {
  if (!existsSync(path)) return { value: {} }
  try { return { value: JSON.parse(readFileSync(path, 'utf8')) as Exemptions } }
  catch (e) { return { value: {}, problem: `${toPosix(path)}: ${(e as Error).message}` } }
}

/** Validates expiry; returns the waivers that are still in force plus EX violations. */
export function activeExemptions(ex: Exemptions, today = todayUtc()): { legacy: string[]; waivers: Map<string, Set<string>>; violations: Violation[] } {
  const violations: Violation[] = [], waivers = new Map<string, Set<string>>()
  const live = (expires: unknown, module: string, what: string) => {
    if (!isoDate(expires)) { violations.push({ rule: 'EX', module, message: `${what}: "expires" must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(expires)}` }); return false }
    if (today > expires) { violations.push({ rule: 'EX', module, message: `${what} expired on ${expires}; finish the move and delete the entry from tools/exemptions.json` }); return false }
    return true
  }
  let legacy: string[] = []
  if (ex.legacy && live(ex.legacy.expires, 'src', 'legacy exemption')) legacy = (ex.legacy.paths ?? []).map(toPosix)
  for (const [dir, w] of Object.entries(ex.modules ?? {}))
    if (live(w?.expires, dir, `waiver of ${(w?.waive ?? []).join('/') || 'nothing'}`)) {
      const bad = (w.waive ?? []).filter(r => !/^M[123]$/.test(r))
      if (bad.length) violations.push({ rule: 'EX', module: dir, message: `only M1-M3 can be waived, not ${bad.join(', ')}` })
      waivers.set(dir, new Set(w.waive ?? []))
    }
  return { legacy, waivers, violations }
}

/** True when `rel` (posix, relative to the repo root) is a listed legacy file or lies in a listed legacy dir. */
const isLegacy = (rel: string, legacy: readonly string[]) =>
  legacy.some(p => p.endsWith('/') ? rel === p.slice(0, -1) || rel.startsWith(p) : rel === p)

/**
 * Literals that count as "raised by a test": a string literal equal to the code (or a regex literal
 * naming it as a word) inside the arguments of an assertion call, or inside the iterable of a for-of
 * loop whose body makes an assertion (table-driven tests).
 */
function assertedLiterals(file: string): Set<string> {
  const found = new Set<string>(), sf = parse(file)
  const isAssertion = (n: ts.Node): n is ts.CallExpression => {
    if (!ts.isCallExpression(n)) return false
    const callee = n.expression.getText(sf)
    return /(?:^|\.)(?:assert|expect|rejects|throws|doesNotThrow|doesNotReject|equal|strictEqual|deepEqual|deepStrictEqual|match|ok|partialDeepStrictEqual)\b/.test(callee) || /^assert\b/.test(callee)
  }
  const collect = (root: ts.Node) => visit(root, n => {
    if (ts.isStringLiteralLike(n)) found.add(n.text)
    else if (ts.isRegularExpressionLiteral(n)) for (const w of n.text.match(/[A-Za-z0-9_]+/g) ?? []) found.add(w)
  })
  visit(sf, n => {
    if (isAssertion(n)) n.arguments.forEach(collect)
    if (ts.isForOfStatement(n)) { let asserts = false; visit(n.statement, m => { if (isAssertion(m)) asserts = true }); if (asserts) collect(n.expression) }
  })
  return found
}

export function checkModule(m: ModuleInfo, options: CheckOptions = {}): Violation[] {
  const { waivers } = activeExemptions(options.exemptions ?? {}, options.today)
  const waived = waivers.get(m.dir) ?? new Set<string>()
  const out: Violation[] = []
  const push = (rule: 'M1' | 'M2' | 'M3', message: string) => { if (!waived.has(rule)) out.push({ rule, module: m.dir, message }) }

  const calls = findDiagnosticsCalls(m.root)
  if (calls.length !== 1) push('M1', `expected exactly one diagnostics('${m.dir}', [...] as const) call, found ${calls.length}${calls.length ? ` (${calls.map(c => toPosix(c.file)).join(', ')})` : ''}`)
  for (const c of calls) {
    if (c.problem) push('M1', `${toPosix(c.file)}: ${c.problem}`)
    else if (c.domain !== m.dir) push('M1', `${toPosix(c.file)}: diagnostics domain '${c.domain}' must be the directory name '${m.dir}'`)
  }

  const tests = walk(m.tests, TEST)
  if (!tests.length) { push('M2', `${toPosix(m.tests)}/ has no *.test.* file`); return out }

  const codes = [...new Set(calls.flatMap(c => c.codes ?? []))]
  if (codes.length) {
    const asserted = new Set<string>()
    for (const t of tests) for (const s of assertedLiterals(t)) asserted.add(s)
    for (const code of codes) if (!asserted.has(code)) push('M3', `declared code '${code}' is not asserted by any test in ${toPosix(m.tests)}/`)
  }
  return out
}

interface ImportEdge { file: string; specifier: string; target?: string }
function importsOf(file: string): ImportEdge[] {
  const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
  return info.importedFiles.map(({ fileName }) => ({
    file, specifier: fileName,
    target: fileName.startsWith('.') ? resolveTarget(resolve(dirname(file), fileName)) : undefined,
  }))
}

/** Imports are extensionless; a directory import (`../board`) means its index file. */
function resolveTarget(abs: string): string {
  return existsSync(abs) && statSync(abs).isDirectory() ? join(abs, 'index') : abs
}
const NODE_BUILTIN = /^(?:node:|(?:fs|child_process)(?:\/|$))/

/** Strip a JS/TS extension so `x.js` (specifier) and `x.ts` (file on disk) compare equal. */
const stem = (p: string) => p.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, '')

export function checkSource(src: string, modules: ModuleInfo[], options: CheckOptions = {}): Violation[] {
  const out: Violation[] = []
  const repo = dirname(resolve(src)), rel = (p: string) => toPosix(relative(repo, resolve(p)))
  const { legacy } = activeExemptions(options.exemptions ?? {}, options.today)
  const names = new Set(modules.map(m => m.dir))
  const moduleOf = (abs: string): string | undefined => {
    const parts = toPosix(relative(resolve(src), abs)).split('/')
    return parts.length > 1 && names.has(parts[0]) ? parts[0] : undefined
  }

  // S1: every directory is a module; flat files are index.ts + modules.generated.ts only.
  for (const d of readdirSync(src, { withFileTypes: true })) {
    const path = rel(join(src, d.name))
    if (d.isDirectory()) { if (!names.has(d.name) && !isLegacy(path + '/', legacy)) out.push({ rule: 'S1', module: 'src', message: `${path}/ has no index.ts (unowned code)` }) }
    else if (!['index.ts', 'modules.generated.ts'].includes(d.name) && !isLegacy(path, legacy))
      out.push({ rule: 'S1', module: 'src', message: `${path}: only src/index.ts and src/modules.generated.ts may live directly in src/` })
  }

  // S2 + S4 + graph for S3
  const graph = new Map<string, Set<string>>([...names].map(n => [n, new Set<string>()]))
  for (const file of walk(src, SOURCE)) {
    const owner = moduleOf(resolve(file)), path = rel(file), legacyFile = !owner && isLegacy(path, legacy)
    for (const edge of importsOf(file)) {
      if (NODE_BUILTIN.test(edge.specifier) && owner !== 'adapters' && !legacyFile)
        out.push({ rule: 'S4', module: owner ?? 'src', message: `${path} imports '${edge.specifier}'; Node built-ins belong in src/adapters/` })
      if (!owner || !edge.target) continue
      const targetModule = moduleOf(edge.target)
      if (targetModule === owner) continue
      if (stem(edge.target) === stem(resolve(src, 'modules.generated.ts'))) continue
      if (!targetModule) {
        if (toPosix(relative(resolve(src), edge.target)).startsWith('..')) continue // outside src/ (e.g. generated client assets) is not a module boundary
        out.push({ rule: 'S2', module: owner, message: `${path} imports '${edge.specifier}', which is not owned by any module` })
        continue
      }
      graph.get(owner)!.add(targetModule)
      if (stem(edge.target) !== stem(resolve(src, targetModule, 'index.ts')))
        out.push({ rule: 'S2', module: owner, message: `${path} imports '${edge.specifier}'; cross-module imports must target ../${targetModule}` })
    }
  }

  // S3: strongly connected components of size > 1 are cycles (Tarjan).
  let index = 0
  const idx = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>()
  const strong = (v: string) => {
    idx.set(v, index); low.set(v, index++); stack.push(v); on.add(v)
    for (const w of [...graph.get(v)!].sort()) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)) }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!))
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = []
      let w: string
      do { w = stack.pop()!; on.delete(w); scc.push(w) } while (w !== v)
      if (scc.length > 1) {
        scc.sort()
        const edges = scc.flatMap(a => [...graph.get(a)!].filter(b => scc.includes(b)).sort().map(b => `${a} -> ${b}`))
        out.push({ rule: 'S3', module: scc[0], message: `import cycle among {${scc.join(', ')}}: ${edges.join(', ')}` })
      }
    }
  }
  for (const v of [...graph.keys()].sort()) if (!idx.has(v)) strong(v)

  // S5: the root entry only re-exports module surfaces.
  const entry = join(src, 'index.ts')
  if (existsSync(entry)) for (const edge of importsOf(entry)) {
    const ok = edge.target !== undefined && (
      [...names].some(n => stem(edge.target!) === stem(resolve(src, n, 'index.ts'))) ||
      stem(edge.target) === stem(resolve(src, 'modules.generated.ts')) ||
      isLegacy(toPosix(relative(repo, edge.target)).replace(/\.js$/, '.ts'), legacy) ||
      isLegacy(toPosix(relative(repo, edge.target)) + '.ts', legacy) ||
      isLegacy(toPosix(relative(repo, edge.target)), legacy))
    if (!ok) out.push({ rule: 'S5', module: 'src', message: `${rel(entry)} imports '${edge.specifier}'; only ./<module> and ./modules.generated are allowed` })
  }

  // S6: generated unions are current.
  const generated = join(src, 'modules.generated.ts')
  const current = existsSync(generated) ? readFileSync(generated, 'utf8') : ''
  const codes = new Map(modules.map(m => [m.dir, findDiagnosticsCalls(m.root).flatMap(c => c.codes ?? [])]))
  const expected = renderModulesGenerated(modules, codes, current)
  if (current !== expected) {
    const before = parseModulesGenerated(current), after = parseModulesGenerated(expected)
    const diff = (k: 'domains' | 'codes') => [...after[k]].filter(x => !before[k].has(x)).map(x => `+${x}`)
      .concat([...before[k]].filter(x => !after[k].has(x)).map(x => `-${x}`))
    const parts = [['DomainName', diff('domains')], ['DiagnosticCode', diff('codes')]].filter(([, d]) => d.length).map(([n, d]) => `${n} ${(d as string[]).join(' ')}`)
    out.push({ rule: 'S6', module: 'src', message: `${rel(generated)} is stale (${parts.length ? parts.join('; ') : 'formatting only'}); run check:modules --write` })
  }
  return out
}

/** The string literals of the DomainName and DiagnosticCode unions, read from the AST. */
export function parseModulesGenerated(text: string): { domains: Set<string>; codes: Set<string> } {
  const sf = ts.createSourceFile('modules.generated.ts', text, ts.ScriptTarget.Latest, true)
  const result = { domains: new Set<string>(), codes: new Set<string>() }
  for (const s of sf.statements) if (ts.isTypeAliasDeclaration(s)) {
    const into = s.name.text === 'DomainName' ? result.domains : s.name.text === 'DiagnosticCode' ? result.codes : undefined
    if (into) visit(s.type, n => { if (ts.isLiteralTypeNode(n) && ts.isStringLiteral(n.literal)) into.add(n.literal.text) })
  }
  return result
}

const union = (items: string[], perLine = 6) => {
  if (!items.length) return '  never'
  const lines: string[] = []
  for (let i = 0; i < items.length; i += perLine) lines.push('  | ' + items.slice(i, i + perLine).map(x => `'${x}'`).join(' | '))
  return lines.join('\n')
}

/**
 * DomainName = module dirs. DiagnosticCode = codes already in the existing file (seeded from today's
 * raised codes; never dropped) ∪ every literal in a module's diagnostics tuple. Sorted, deterministic.
 */
export function renderModulesGenerated(modules: ModuleInfo[], codes: Map<string, string[]>, existing = ''): string {
  const domains = [...new Set(modules.map(m => m.dir))].sort()
  const all = [...new Set([...parseModulesGenerated(existing).codes, ...[...codes.values()].flat()])].sort()
  return `// GENERATED by scripts/check-modules.ts --write. Do not edit.
// DomainName: every directory src/<name>/ containing index.ts.
export type DomainName =
${union(domains)}
/**
 * Union of every literal passed to diagnostics(domain, [...]) across src/.
 * Seeded from the codes today's code raises; tests/compat/codes.test.ts pins this set.
 * A code may be raised by more than one module.
 */
export type DiagnosticCode =
${union(all)}
`
}

/** Runs every rule against a repo root (containing src/, tests/, tools/exemptions.json). */
export function runChecks(root: string, { write = false, today = todayUtc() }: { write?: boolean; today?: string } = {}): Violation[] {
  root = resolve(root)
  const src = join(root, 'src')
  const loaded = loadExemptions(join(root, 'tools', 'exemptions.json'))
  const options: CheckOptions = { today, exemptions: loaded.value }
  const modules = discoverModules(src, join(root, 'tests'))
  if (write) {
    const generated = join(src, 'modules.generated.ts')
    const current = existsSync(generated) ? readFileSync(generated, 'utf8') : ''
    const codes = new Map(modules.map(m => [m.dir, findDiagnosticsCalls(m.root).flatMap(c => c.codes ?? [])]))
    const next = renderModulesGenerated(modules, codes, current)
    if (next !== current) writeFileSync(generated, next)
  }
  const violations: Violation[] = [
    ...(loaded.problem ? [{ rule: 'EX' as const, module: 'src', message: loaded.problem }] : []),
    ...activeExemptions(loaded.value, today).violations,
    ...modules.flatMap(m => checkModule(m, options)),
    ...checkSource(src, modules, options),
  ]
  // Report paths relative to the root so output is stable wherever the script runs from.
  const prefix = toPosix(resolve(root)) + '/'
  const seen = new Set<string>()
  return violations.map(v => ({ ...v, message: v.message.split(prefix).join('') }))
    .filter(v => { const key = formatViolation(v); return !seen.has(key) && !!seen.add(key) })
}

export const formatViolation = (v: Violation) => `${v.rule} ${v.module ?? 'src'}: ${v.message}`

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const violations = runChecks(root, { write: process.argv.includes('--write') })
  for (const v of violations) console.log(formatViolation(v))
  process.exit(violations.length ? 1 : 0)
}
