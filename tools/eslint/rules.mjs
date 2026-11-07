// House lint rules that ESLint and its plugins do not ship. Wired up in eslint.config.mjs.
import { existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const MAX_LINES = 500

/** Warns when a TypeScript file is longer than MAX_LINES lines. */
const maxFileLines = {
  meta: {
    type: 'suggestion',
    docs: { description: `Warn when a TypeScript file is longer than ${MAX_LINES} lines` },
    schema: [],
    messages: {
      tooLong: 'This file has {{lines}} lines (limit {{max}}). Split it into smaller files. ' +
        'If it is important to keep it as one file, add this line at the top with the reason: ' +
        '/* eslint-disable local/max-file-lines -- <why this file stays whole> */',
    },
  },
  create(context) {
    return {
      Program(node) {
        const all = context.sourceCode.lines
        // A final newline leaves an empty last entry; it is not a line of the file.
        const lines = all.at(-1) === '' ? all.length - 1 : all.length
        if (lines > MAX_LINES) context.report({ node, loc: { line: 1, column: 0 }, messageId: 'tooLong', data: { lines, max: MAX_LINES } })
      },
    }
  },
}

// Test folders that check the package or the tooling as a whole, not one source file.
const CROSS_CUTTING = ['tests/compat/', 'tests/tooling/', 'tests/support/']

/**
 * Each test file is named after the one source file it tests:
 * tests/<module>/<path>.test.<ext> tests src/<module>/<path>.ts (or src/<module>/<path>/index.ts).
 * Because names are unique, every source file then has at most one test file.
 */
const testFileMatchesSource = {
  meta: {
    type: 'suggestion',
    docs: { description: 'A test file is named after the single source file it tests' },
    schema: [],
    messages: {
      noSource: "{{test}} does not match a source file. Name it after the file it tests: '{{expected}}' should exist (or '{{expectedIndex}}').",
      duplicate: '{{source}} already has a test file ({{other}}). Keep one test file per source file.',
    },
  },
  create(context) {
    const root = context.cwd
    const test = relative(root, context.filename).split(sep).join('/')
    const match = /^tests\/(.+)\.test\.(?:ts|tsx|mjs)$/.exec(test)
    if (!match || CROSS_CUTTING.some(dir => test.startsWith(dir))) return {}
    const base = match[1]
    const expected = `src/${base}.ts`
    const expectedIndex = `src/${base}/index.ts`
    return {
      Program(node) {
        const loc = { line: 1, column: 0 }
        if (!existsSync(join(root, expected)) && !existsSync(join(root, expectedIndex))) {
          context.report({ node, loc, messageId: 'noSource', data: { test, expected, expectedIndex } })
          return
        }
        const siblings = ['ts', 'tsx', 'mjs'].map(ext => `tests/${base}.test.${ext}`).filter(f => f !== test && existsSync(join(root, f)))
        if (siblings.length) context.report({ node, loc, messageId: 'duplicate', data: { source: expected, other: siblings.join(', ') } })
      },
    }
  },
}

/** The nodes that count as "a function" for the signature rule: anything with its own name. */
function namedFunction(node) {
  const parent = node.parent
  if (node.type === 'FunctionDeclaration') return node.id ? node.id.name : 'default export'
  if (parent.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'Identifier') return parent.id.name
  if (parent.type === 'MethodDefinition' && parent.value === node) return parent.key.name ?? 'method'
  if (parent.type === 'PropertyDefinition' && parent.value === node) return parent.key.name ?? 'property'
  return undefined
}

/** True when a parameter carries its own type annotation (`x: T`, `x: T = d`, `...xs: T[]`, `{a}: T`). */
function paramTyped(param) {
  if (param.type === 'TSParameterProperty') return paramTyped(param.parameter)
  if (param.type === 'AssignmentPattern') return Boolean(param.left.typeAnnotation)
  return Boolean(param.typeAnnotation)
}

/** Named functions spell out every parameter type and the return type in the signature. */
const typedSignature = {
  meta: {
    type: 'problem',
    docs: { description: 'Named functions declare parameter and return types in their signature' },
    schema: [],
    messages: {
      param: "Function '{{name}}': give parameter {{index}} a type in the signature.",
      returns: "Function '{{name}}': declare the return type in the signature.",
    },
  },
  create(context) {
    function check(node) {
      const name = namedFunction(node)
      if (name === undefined) return
      node.params.forEach((param, i) => {
        if (!paramTyped(param)) context.report({ node: param, messageId: 'param', data: { name, index: i + 1 } })
      })
      const parent = node.parent
      const noReturnType = parent.type === 'MethodDefinition' && (parent.kind === 'constructor' || parent.kind === 'set')
      if (!noReturnType && !node.returnType) context.report({ node: node.id ?? node, messageId: 'returns', data: { name } })
    }
    return { FunctionDeclaration: check, FunctionExpression: check, ArrowFunctionExpression: check }
  },
}

export default {
  meta: { name: 'local' },
  rules: { 'max-file-lines': maxFileLines, 'test-file-matches-source': testFileMatchesSource, 'typed-signature': typedSignature },
}
