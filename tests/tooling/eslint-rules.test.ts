import { describe, it } from 'node:test'
import { join } from 'node:path'
import { RuleTester, type Rule } from 'eslint'
import tseslint from 'typescript-eslint'
import plugin from '../../tools/eslint/rules.mjs'

// The custom rules in tools/eslint/rules.mjs, checked on small inputs.
RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only
const rules = plugin.rules as unknown as Record<string, Rule.RuleModule>
const root = join(import.meta.dirname, '..', '..')
const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } })

tester.run('typed-signature', rules['typed-signature'], {
  valid: [
    'function f(a: number, b: string = "x"): void {}',
    'const g = (a: number): number => a',
    'class A { constructor(a: number) {} m(): void {} }',
    'xs.map(x => x * 2)',
  ],
  invalid: [
    { code: 'function f(a: number) {}', errors: [{ messageId: 'returns' }] },
    { code: 'const g = (a): number => a', errors: [{ messageId: 'param' }] },
    { code: 'class A { m(a) {} }', errors: [{ messageId: 'returns' }, { messageId: 'param' }] },
  ],
})

tester.run('max-file-lines', rules['max-file-lines'], {
  valid: ['const a = 1\n'.repeat(500)],
  invalid: [{ code: 'const a = 1\n'.repeat(501), errors: [{ messageId: 'tooLong' }] }],
})

tester.run('test-file-matches-source', rules['test-file-matches-source'], {
  valid: [
    { code: '', filename: join(root, 'tests/board/stackup.test.ts') },
    { code: '', filename: join(root, 'tests/board/index.test.ts') },
    { code: '', filename: join(root, 'tests/compat/anything.test.ts') },
  ],
  invalid: [{ code: '', filename: join(root, 'tests/board/nothing-like-this.test.ts'), errors: [{ messageId: 'noSource' }] }],
})
