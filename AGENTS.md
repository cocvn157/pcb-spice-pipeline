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

- `pnpm check:modules && pnpm typecheck && pnpm test` must pass before a PR is ready.
- Relative imports have no extension: `from './stages'`, and `from '../board'` for another module (enforced by `tests/tooling/imports.test.ts`). The build adds `.js` back in `dist/`.
- Module rules, verification and migration notes: `docs/ARCHITECTURE.md`.
- Output must stay byte-identical unless the PR says otherwise: `tests/compat/` pins exports, error codes, artifact paths and hashes.
