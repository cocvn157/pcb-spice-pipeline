import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const src = join(repo, 'src')

// Every code today's library (flat src/ of 2026-11-07, excluding src/legacy/) can raise, plus the three
// codes ARCHITECTURE.md introduces for the ledger and report (artifact_collision, artifact_path,
// report_missing_artifact). Renaming, inventing or dropping a code must be a deliberate edit here.
// Dropped at the switch-over (raised only by unported legacy code that left src/: eyediagram.mjs,
// metrics.mjs measureWaveform/foldEye, spice.ts's two-lane netlist, and the tsx helpers now in
// tests/support/): clock_ui, eye, eyediagram, power, propagation, stimulus, tsx_board, tsx_reference,
// tsx_scope, tsx_simulation, tsx_supply.
const RAISED = [
  'analytic_resistance', 'analytic_return', 'cap_convergence', 'capacitance_sign', 'channel_fanout', 'channel_model',
  'channel_net', 'channel_short', 'circuit_json', 'circuit_schema', 'conductor_overlap',
  'converter_version', 'copper_surface', 'ddr_config', 'ddr_probe', 'electrical_input', 'empty_route',
  'endpoint_layer', 'endpoint_position', 'extraction', 'eye_budget', 'eye_interpolation',
  'eye_probe', 'eye_reference', 'eye_resolution', 'eye_timing', 'eye_windows',
  'fastercap_output', 'fastercap_ports', 'fasthenry_output', 'fasthenry_ports', 'file_path', 'floating_reference',
  'floating_source', 'ground_connection', 'ground_connectivity', 'ground_geometry', 'ground_mesh', 'ground_net',
  'ground_reference', 'ibis_asset', 'ibis_asset_missing', 'ibis_contract', 'ibis_mapping', 'ibis_model',
  'ibis_state', 'lane_spacing', 'lanes', 'layer_transition', 'matrix_dimension', 'matrix_format',
  'matrix_order', 'matrix_zero', 'mesh_convergence', 'model_frequency', 'modeling_input', 'native_convergence',
  'native_declaration', 'native_geometry', 'native_output', 'native_solver', 'native_timeout', 'passive_capability',
  'passive_reference', 'passivity', 'pcb_spice_channel', 'pin_mapping', 'probe_observation',
  'probe_reference', 'reciprocity', 'reduction', 'reference', 'reference_energy',
  'result_schema', 'return_geometry', 'route_geometry', 'route_selection', 'route_topology', 'route_type',
  'sections', 'simulation_capability', 'simulation_duration', 'simulation_experiment', 'simulation_id', 'simulation_probe',
  'simulation_reference', 'simulation_scope', 'simulation_start', 'simulation_timing', 'solver_result', 'source_capability',
  'source_edge', 'spice_options', 'stackup', 'stale_endpoint', 'stimulus_coverage',
  'stimulus_duplicate', 'stimulus_missing', 'stimulus_pattern', 'stimulus_state', 'supply_missing', 'supply_reference',
  'supply_short',
  'varying_width', 'vendor_hash', 'via_geometry', 'via_stub', 'waveform',
  'artifact_collision', 'artifact_path', 'report_missing_artifact',
].sort()

function diagnosticCodeUnion(): string[] {
  const text = readFileSync(join(src, 'modules.generated.ts'), 'utf8')
  const sf = ts.createSourceFile('modules.generated.ts', text, ts.ScriptTarget.Latest, true)
  const alias = sf.statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === 'DiagnosticCode')
  assert.ok(alias, 'src/modules.generated.ts declares DiagnosticCode')
  const codes: string[] = []
  const visit = (n: ts.Node) => { if (ts.isLiteralTypeNode(n) && ts.isStringLiteral(n.literal)) codes.push(n.literal.text); ts.forEachChild(n, visit) }
  visit(alias.type)
  return codes
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'legacy' && dir === src ? [] : sources(path)
    return /\.(?:[cm]?ts|[cm]?js)$/.test(name) && !name.endsWith('.d.ts') ? [path] : []
  })
}

/** String literals a call can pass as a code: 'x', or either branch of `cond ? 'x' : 'y'`. */
const literals = (e: ts.Expression | undefined): string[] => {
  if (!e) return []
  if (ts.isStringLiteralLike(e)) return [e.text]
  if (ts.isConditionalExpression(e)) return [...literals(e.whenTrue), ...literals(e.whenFalse)]
  if (ts.isParenthesizedExpression(e)) return literals(e.expression)
  return []
}

/** Literal codes passed to fail(code, ...) or new Diagnostic(domain, code, ...) anywhere in non-legacy src/. */
function literalRaises(): Map<string, string[]> {
  const raised = new Map<string, string[]>()
  for (const file of sources(src)) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const add = (codes: string[]) => { for (const c of codes) raised.set(c, [...(raised.get(c) ?? []), relative(repo, file)]) }
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'fail') add(literals(n.arguments[0]))
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Diagnostic' && (n.arguments?.length ?? 0) >= 3)
        add(literals(n.arguments![1]))
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return raised
}

test('DiagnosticCode in src/modules.generated.ts equals the pinned set of raisable codes', () => {
  const union = diagnosticCodeUnion()
  assert.equal(new Set(union).size, union.length, 'no duplicate literals')
  assert.deepEqual([...union].sort(), RAISED)
})

test('every literal code raised in non-legacy src/ is in the pinned set', () => {
  const pinned = new Set(RAISED), raised = literalRaises()
  const unknown = [...raised].filter(([code]) => !pinned.has(code)).map(([code, files]) => `${code} (${[...new Set(files)].join(', ')})`)
  assert.deepEqual(unknown, [])
  assert.ok(raised.size >= 100, `scanner found ${raised.size} codes; expected today's ~120`)
})
