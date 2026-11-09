// RLGC pi-section subcircuit text (was spice.ts channelSpice; the legacy simulationSpice has no non-legacy caller and stays behind).
import { fail } from './diagnostics'
import { validateMatrix } from './checks'
import { scale, sum, type Matrix } from './linalg'

/** One stage's loop matrices (spice.ts called this `ChannelMatrices`). */
export interface StageMatrices { R: Matrix; L: Matrix; C: Matrix; lanes?: string[]; laneIndices?: number[] }

/** Formats a value with 12 significant digits so the netlist text is stable across runs. */
const num = (value: number): string => Number(value.toPrecision(12)).toString()

/** Writes the RLGC channel as a SPICE subcircuit: each stage is split into equal pi sections with coupled R, L and C between signals. */
export function channelSpice(extracted: readonly StageMatrices[], sections: number): string {
  if (!Number.isInteger(sections) || sections < 1 || sections > 128) fail('sections', 'sections must be an integer 1..128')
  if (!extracted.length || !extracted[0].R.length) fail('matrix_dimension', 'At least one extracted channel stage is required')
  const grouped = extracted.some(stage => stage.laneIndices !== undefined)
  if (grouped && extracted.some(stage => !Array.isArray(stage.laneIndices) || !stage.laneIndices.length || new Set(stage.laneIndices).size !== stage.laneIndices.length || stage.laneIndices.some(i => !Number.isInteger(i) || i < 0))) {
    fail('matrix_dimension', 'Grouped extracted stages require valid distinct laneIndices')
  }
  const allLaneIndices = grouped ? [...new Set(extracted.flatMap(stage => stage.laneIndices!))].sort((a, b) => a - b) : Array.from({ length: extracted[0].R.length }, (_, i) => i)
  const n = allLaneIndices.length
  if (grouped && allLaneIndices.some((lane, index) => lane !== index)) fail('matrix_dimension', 'Extracted stage groups must cover every channel lane 0..n-1')
  const stageLaneIndices = extracted.map(stage => stage.laneIndices ?? allLaneIndices)
  for (let a = 0; a < stageLaneIndices.length; a++) for (let b = a + 1; b < stageLaneIndices.length; b++) {
    const common = stageLaneIndices[a].filter(lane => stageLaneIndices[b].includes(lane))
    if (common.length && (common.length !== stageLaneIndices[a].length || common.length !== stageLaneIndices[b].length || stageLaneIndices[a].some((lane, i) => lane !== stageLaneIndices[b][i]))) {
      fail('matrix_dimension', 'Extracted stage laneIndices must form disjoint lane groups')
    }
  }
  for (const [stage, matrices] of extracted.entries()) {
    const m = stageLaneIndices[stage].length
    for (const kind of ['R', 'L', 'C'] as const) {
      if (matrices[kind].length !== m) fail('matrix_dimension', `Stage ${stage} ${kind}: channel dimensions disagree`)
      validateMatrix(matrices[kind], `Stage ${stage} ${kind}`, 1e-10)
    }
    if (matrices.C.some((row, i) => row.some((entry, j) => i !== j && entry > 0) || sum(row) <= 0)) {
      fail('capacitance_sign', `Stage ${stage}: referenced Maxwell C requires nonpositive mutual and positive shunt capacitance`)
    }
  }
  const inputs = Array.from({ length: n }, (_, i) => `IN${i}`)
  const outputs = Array.from({ length: n }, (_, i) => `OUT${i}`)
  const lines = ['* Constant-frequency passive matrix pi channel; explicit reference terminal', `.subckt CHANNEL ${[...inputs, ...outputs, 'REF'].join(' ')}`]
  const laneSectionCount = Array.from({ length: n }, (_, lane) => stageLaneIndices.filter(lanes => lanes.includes(lane)).length * sections)
  const laneSectionIndex = Array.from({ length: n }, () => 0)
  let global = 0
  for (const [stage, e] of extracted.entries()) for (let section = 0; section < sections; section++) {
    const g = global++
    const lanes = stageLaneIndices[stage]
    const m = lanes.length
    const R: Matrix = scale(e.R, 1 / sections)
    const L: Matrix = scale(e.L, 1 / sections)
    const C: Matrix = scale(e.C, 1 / sections)
    const sectionIndices = lanes.map(lane => laneSectionIndex[lane]++)
    const before = lanes.map((lane, k) => sectionIndices[k] === 0 ? inputs[lane] : `N${sectionIndices[k]}_${lane}`)
    const after = lanes.map((lane, k) => sectionIndices[k] === laneSectionCount[lane] - 1 ? outputs[lane] : `N${sectionIndices[k] + 1}_${lane}`)
    for (let k = 0; k < m; k++) {
      const i = lanes[k]
      lines.push(`VS${g}_${i} ${before[k]} S${g}_${i} 0`, `R${g}_${i} S${g}_${i} R${g}_${i} ${num(R[k][k])}`)
      // The shared return contributes cross resistance R_ij * I_j as well as mutual inductance.
      if (m > 1) lines.push(`E${g}_${i} R${g}_${i} L${g}_${i} value={${R[k].flatMap((r, k2) => k2 === k ? [] : [`${num(r)}*i(VS${g}_${lanes[k2]})`]).join('+')}}`)
      lines.push(`L${g}_${i} ${m > 1 ? `L${g}_${i}` : `R${g}_${i}`} ${after[k]} ${num(L[k][k])}`)
    }
    for (let k1 = 0; k1 < m; k1++) for (let k2 = k1 + 1; k2 < m; k2++) lines.push(`K${g}_${lanes[k1]}_${lanes[k2]} L${g}_${lanes[k1]} L${g}_${lanes[k2]} ${num(L[k1][k2] / Math.sqrt(L[k1][k1] * L[k2][k2]))}`)
    for (const [label, nodes] of [['a', before], ['b', after]] as const) {
      for (let k = 0; k < m; k++) lines.push(`CG${g}${label}${lanes[k]} ${nodes[k]} REF ${num(sum(C[k]) / 2)}`)
      for (let k1 = 0; k1 < m; k1++) for (let k2 = k1 + 1; k2 < m; k2++) if (C[k1][k2] < 0) lines.push(`CM${g}${label}${lanes[k1]}_${lanes[k2]} ${nodes[k1]} ${nodes[k2]} ${num(-C[k1][k2] / 2)}`)
    }
  }
  lines.push('.ends CHANNEL')
  return lines.join('\n') + '\n'
}
