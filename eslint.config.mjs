// Lint rules (see AGENTS.md "Lint"). Run with `pnpm lint`.
import tseslint from 'typescript-eslint'
import jsdoc from 'eslint-plugin-jsdoc'
import local from './tools/eslint/rules.mjs'

// "A function" = anything with its own name. Inline callbacks (`xs.map(x => x * 2)`) are exempt.
const NAMED_FUNCTIONS = [
  'FunctionDeclaration',
  'MethodDefinition',
  'VariableDeclarator > ArrowFunctionExpression',
  'VariableDeclarator > FunctionExpression',
  'PropertyDefinition > ArrowFunctionExpression',
  'PropertyDefinition > FunctionExpression',
]

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'runs/**', '.cache/**', 'examples/**/models/**', 'src/report/client/**/*.generated.*'] },
  {
    files: ['**/*.{ts,tsx,mjs}'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: { '@typescript-eslint': tseslint.plugin, jsdoc, local },
    rules: {
      // 1. One variable per declaration: no `const a = 1, b = 2`.
      'one-var': ['error', 'never'],
      // ...and one statement per line: no `const a = 1; const b = 2`.
      'max-statements-per-line': ['error', { max: 1 }],
      // 3. No enums: use a union of string literals or an `as const` object.
      'no-restricted-syntax': ['error', { selector: 'TSEnumDeclaration', message: "Enums are not allowed. Use a string-literal union (type Mode = 'a' | 'b') or an `as const` object." }],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // 2. Every named function has a JSDoc comment and fully typed signature.
      'jsdoc/require-jsdoc': ['error', { require: { FunctionDeclaration: false }, contexts: NAMED_FUNCTIONS, checkConstructors: false, checkGetters: true, checkSetters: true }],
      'local/typed-signature': 'error',
      // 4. Files over 500 lines warn; important files may opt out with a disable comment and a reason.
      'local/max-file-lines': 'warn',
    },
  },
  {
    // 5. One test file per source file: tests/<module>/<name>.test.ts tests src/<module>/<name>.ts.
    files: ['tests/**/*.test.{ts,tsx,mjs}'],
    rules: { 'local/test-file-matches-source': 'error' },
  },
)
