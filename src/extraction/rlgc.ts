// RLGC pi-section subcircuit text (was spice.ts channelSpice; the legacy simulationSpice has no non-legacy caller and stays behind).
import { fail } from './diagnostics'
import { validateMatrix } from './checks'
import { scale, sum, type Matrix } from './linalg'

/** One stage's loop matrices (spice.ts called this `ChannelMatrices`). */
export interface StageMatrices { R: Matrix; L: Matrix; C: Matrix }

/** Formats a value with 12 significant digits so the netlist text is stable across runs. */
const num = (value: number): string => Number(value.toPrecision(12)).toString()

/** Writes the RLGC channel as a SPICE subcircuit: each stage is split into equal pi sections with coupled R, L and C between signals. */
export function channelSpice(extracted: readonly StageMatrices[], sections: number): string {
  if (!Number.isInteger(sections) || sections < 1 || sections > 128) fail('sections', 'sections must be an integer 1..128')
  if (!extracted.length || !extracted[0].R.length) fail('matrix_dimension', 'At least one extracted channel stage is required')
  const n = extracted[0].R.length
  for (const [stage, matrices] of extracted.entries()) {
    for (const kind of ['R', 'L', 'C'] as const) {
      if (matrices[kind].length !== n) fail('matrix_dimension', `Stage ${stage} ${kind}: channel dimensions disagree`)
      validateMatrix(matrices[kind], `Stage ${stage} ${kind}`, 1e-10)
    }
    if (matrices.C.some((row, i) => row.some((entry, j) => i !== j && entry > 0) || sum(row) <= 0)) {
      fail('capacitance_sign', `Stage ${stage}: referenced Maxwell C requires nonpositive mutual and positive shunt capacitance`)
    }
  }
  const inputs = Array.from({ length: n }, (_, i) => `IN${i}`)
  const outputs = Array.from({ length: n }, (_, i) => `OUT${i}`)
  const lines = ['* Constant-frequency passive matrix pi channel; explicit reference terminal', `.subckt CHANNEL ${[...inputs, ...outputs, 'REF'].join(' ')}`]
  let global = 0
  for (const [stage, e] of extracted.entries()) for (let section = 0; section < sections; section++) {
    const g = global++
    const R: Matrix = scale(e.R, 1 / sections)
    const L: Matrix = scale(e.L, 1 / sections)
    const C: Matrix = scale(e.C, 1 / sections)
    const first = g === 0
    const last = stage === extracted.length - 1 && section === sections - 1
    const before = inputs.map((input, i) => first ? input : `N${g}_${i}`)
    const after = outputs.map((output, i) => last ? output : `N${g + 1}_${i}`)
    for (let i = 0; i < n; i++) {
      lines.push(`VS${g}_${i} ${before[i]} S${g}_${i} 0`, `R${g}_${i} S${g}_${i} R${g}_${i} ${num(R[i][i])}`)
      // The shared return contributes cross resistance R_ij * I_j as well as mutual inductance.
      if (n > 1) lines.push(`E${g}_${i} R${g}_${i} L${g}_${i} value={${R[i].flatMap((r, j) => j === i ? [] : [`${num(r)}*i(VS${g}_${j})`]).join('+')}}`)
      lines.push(`L${g}_${i} ${n > 1 ? `L${g}_${i}` : `R${g}_${i}`} ${after[i]} ${num(L[i][i])}`)
    }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) lines.push(`K${g}_${i}_${j} L${g}_${i} L${g}_${j} ${num(L[i][j] / Math.sqrt(L[i][i] * L[j][j]))}`)
    for (const [label, nodes] of [['a', before], ['b', after]] as const) {
      for (let i = 0; i < n; i++) lines.push(`CG${g}${label}${i} ${nodes[i]} REF ${num(sum(C[i]) / 2)}`)
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (C[i][j] < 0) lines.push(`CM${g}${label}${i}_${j} ${nodes[i]} ${nodes[j]} ${num(-C[i][j] / 2)}`)
    }
  }
  lines.push('.ends CHANNEL')
  return lines.join('\n') + '\n'
}
