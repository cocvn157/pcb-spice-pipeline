import type { ConvertedIbisComponent } from '@tscircuit/ibis-to-spice'
import { fail, scale, sum, validateMatrix } from './matrices.mjs'

export type Matrix = number[][]
export interface ChannelMatrices { R: Matrix; L: Matrix; C: Matrix; lanes?: string[]; laneIndices?: number[] }
type ConvertedSource = Pick<ConvertedIbisComponent, 'source' | 'spicePinMapping'>
interface LegacyModeling {
  sections: number
  lanes: Array<{ port: string; driverPort?: string; receiverPort?: string }>
  driver: { power: { vdd: string; vss: string } }
  receiver: { power: { vdd: string; vss: string } }
  simulation: { supplyV: number; stepSeconds: number; durationSeconds: number }
}

const num = (value: number): string => Number(value.toPrecision(12)).toString()

export function channelSpice(extracted: ChannelMatrices[], sections: number): string {
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
    const shared = stageLaneIndices[a].filter(lane => stageLaneIndices[b].includes(lane))
    if (shared.length && (shared.length !== stageLaneIndices[a].length || shared.length !== stageLaneIndices[b].length || stageLaneIndices[a].some((lane, i) => lane !== stageLaneIndices[b][i]))) {
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
  const totalLaneSections = Array.from({ length: n }, (_, lane) => stageLaneIndices.filter(lanes => lanes.includes(lane)).length * sections)
  const laneSectionIndex = Array.from({ length: n }, () => 0)
  let global = 0
  for (const [stage, e] of extracted.entries()) for (let section = 0; section < sections; section++) {
    const g = global++, lanes = stageLaneIndices[stage], m = lanes.length
    const R: Matrix = scale(e.R, 1 / sections), L: Matrix = scale(e.L, 1 / sections), C: Matrix = scale(e.C, 1 / sections)
    const sectionIndices = lanes.map(lane => laneSectionIndex[lane]++)
    const before = lanes.map((lane, k) => sectionIndices[k] === 0 ? inputs[lane] : `N${sectionIndices[k]}_${lane}`)
    const after = lanes.map((lane, k) => sectionIndices[k] === totalLaneSections[lane] - 1 ? outputs[lane] : `N${sectionIndices[k] + 1}_${lane}`)
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

function instance(label: string, converted: ConvertedSource, signalNodes: Record<string, string>, ports: { vdd: string; vss: string }): string {
  const wrapper = converted.source.match(/^\.subckt\s+(\S+)\s+(.+)$/mi)
  if (!wrapper) return fail('ibis_contract', 'Converter did not emit a component wrapper')
  const nodes = wrapper[2].trim().split(/\s+/).map(terminal => {
    const mapped = converted.spicePinMapping[terminal]
    if (mapped === ports.vdd) return 'vdd'
    if (mapped === ports.vss) return '0'
    if (!Object.hasOwn(signalNodes, mapped)) fail('ibis_mapping', `Unknown returned terminal ${terminal} -> ${mapped}`)
    return signalNodes[mapped]
  })
  return `X${label} ${nodes.join(' ')} ${wrapper[1]}`
}

export function simulationSpice(modeling: LegacyModeling, extracted: ChannelMatrices[], driver: ConvertedSource, receiver: ConvertedSource): string {
  const s = modeling.simulation
  if (!Number.isFinite(s.supplyV) || s.supplyV <= 0) fail('power', 'Explicit simulation.supplyV required')
  if (modeling.lanes.length !== 2 || extracted.some(stage => stage.R.length !== 2)) fail('matrix_dimension', 'Legacy differential simulation requires exactly two channels')
  const driverNodes = Object.fromEntries(modeling.lanes.map((l, i) => [l.driverPort ?? l.port, `drv${i}`]))
  const receiverNodes = Object.fromEntries(modeling.lanes.map((l, i) => [l.receiverPort ?? l.port, `rx${i}`]))
  if (new Set([...Object.values(driverNodes), ...Object.values(receiverNodes)]).size !== 4) fail('channel_short', 'Driver and receiver must have four distinct nodes')
  return ['PCB extracted channel with original vendor IBIS tables', '.options reltol=1e-5 abstol=1e-12 method=gear', `VDD vdd 0 ${num(s.supplyV)}`, driver.source, receiver.source, channelSpice(extracted, modeling.sections), instance('DRIVER', driver, driverNodes, modeling.driver.power), instance('RECEIVER', receiver, receiverNodes, modeling.receiver.power), 'XCHAN drv0 drv1 rx0 rx1 0 CHANNEL', '.control', 'set wr_singlescale', 'set wr_vecnames', `tran ${num(s.stepSeconds)} ${num(s.durationSeconds)} 0 ${num(s.stepSeconds)}`, 'let vdiff = v(rx0)-v(rx1)', 'let vdrive = v(drv0)-v(drv1)', 'wrdata waveform.dat v(drv0) v(drv1) v(rx0) v(rx1) vdiff vdrive', 'quit', '.endc', '.end', ''].join('\n')
}
