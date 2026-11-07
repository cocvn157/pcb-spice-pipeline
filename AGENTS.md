# Rules for agents and contributors

This is the only agent rules file. Do not add CLAUDE.md, GEMINI.md, .cursorrules or similar; tests/tooling/docs.test.ts fails if one appears.

## Diagrams: Mermaid only (enforced by `tests/tooling/docs.test.ts`)

1. Every diagram in this repo is a fenced ```` ```mermaid ```` block inside Markdown: README, `docs/`, and PR descriptions alike.
   Never commit or upload diagram images (PNG/SVG/JPG renders, screenshots of diagrams).
2. Each diagram is one of exactly two concepts:
   - **Workflow:** `flowchart` (data or call flow: what happens, which module owns each step).
   - **State machine:** `stateDiagram-v2` (phases, transitions, terminal and failure states).
   Anything else (module tables, file maps, rule lists) is a Markdown table, not a diagram.
3. When code changes a workflow or a state machine (new stage, new module step, new failure path), update its diagram in the same PR.

## README contract (enforced by the same test)

`README.md` starts with these sections, in this order:
1. `## What is it?`
2. `## How to use it?`
3. `## General workflow`: contains at least one `flowchart` and one `stateDiagram-v2` block.

## Code

- `pnpm lint && pnpm check:modules && pnpm check:vocabulary && pnpm typecheck && pnpm test` must pass before a PR is ready.
- Relative imports have no extension: `from './stages'`, and `from '../board'` for another module (enforced by `tests/tooling/imports.test.ts`). The build adds `.js` back in `dist/`.
- Module rules, verification and migration notes: `docs/ARCHITECTURE.md`.
- Output must stay byte-identical unless the PR says otherwise: `tests/compat/` pins exports, error codes, artifact paths and hashes.

## Lint (`pnpm lint`, config in `eslint.config.mjs`, custom rules in `tools/eslint/rules.mjs`)

| Rule | What it means |
|---|---|
| One variable per declaration | `const a = 1, b = 2` is not allowed. Write each on its own line. |
| One statement per line | No `const a = 1; const b = 2` on one line. |
| Every named function has JSDoc and a typed signature | Function declarations, methods and `const f = () => …` need a `/** … */` comment, a type on every parameter and a return type. Inline callbacks like `xs.map(x => x * 2)` are exempt. |
| No enums | Use a string-literal union (`type Mode = 'a' \| 'b'`) or an `as const` object. |
| TypeScript files over 500 lines warn | Split the file. If it is important to keep it whole, add `/* eslint-disable local/max-file-lines -- <reason> */` at the top. |
| One test file per source file | `tests/<module>/<name>.test.ts` tests `src/<module>/<name>.ts` (or `<name>/index.ts`). Many tests per file are fine. `tests/compat`, `tests/tooling` and `tests/support` test the package as a whole and are exempt. |

## Naming vocabulary (`pnpm check:vocabulary`, dictionary in `tools/vocabulary.yaml`)

Build names in `src/` from the words in `tools/vocabulary.yaml`. The checker splits every declared name into words (`foldProbeEye` → fold, probe, eye) and reports the share of names made only of dictionary words. It must stay at or above the file's `threshold` (85%). 100% is not the goal.

- Prefer a word already in the dictionary. If it lists two words for one idea, use the listed one; `avoid` names the word to use instead.
- Need a new concept? Add the word with a one-line plain-English meaning in the same PR as the code that uses it, so the reviewer sees the new word.
- List base forms only: plurals and verb forms are accepted automatically (`ids` → id, `selected` → select).
