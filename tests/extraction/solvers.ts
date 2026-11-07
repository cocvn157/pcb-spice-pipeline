// Canned native answers for extraction tests (not a substitute solver: they echo the geometry's own analytic R).
import type { RunSolver, SolverRequest } from '../../src/solver/index.js'
import type { Geometry, GeometryCell, Modeling } from '../../src/board/index.js'

/** Perturbations: R scale per run (0 coarse, 1 refined), DC mutual R, omit port rows, coarse frequencies. */
export interface Tweak { rScale?: [number, number]; lowMutualR?: number; noRows?: boolean; coarseHz?: number[] }

/** A canned solver whose answers pass every check for the geometry it is given (R = analytic DC R). */
export function consistentSolver(geometry: Geometry, modeling: Modeling, tweak: Tweak = {}): RunSolver {
  let call = 0
  return async (request: SolverRequest) => {
    const cell = geometry.cells[Math.floor(call / 3)], phase = call++ % 3, n = cell.conductors.length, routed = !!cell.routedCopper
    if (request.solver === 'fastercap') {
      const unit = routed ? 1e-9 : 1e-12
      return { stdout: `Capacitance matrix is:\nDimension ${n} x ${n}\n` + cell.conductors.map((c, i) => `g_${c.name} ` + cell.conductors.map((_, j) => (i === j ? 4 : -1) * unit).join(' ')).join('\n') +
        '\n\nWeighted Frobenius norm of the difference between capacitance (auto option): 0.001\n', stderr: '', files: {} as Record<string, string> }
    }
    const r = analytic(cell).map(v => v * (tweak.rScale?.[phase] ?? 1)), frequencies = phase === 0 ? (tweak.coarseHz ?? [modeling.extraction.minimumHz, modeling.extraction.modelHz]) : [modeling.extraction.modelHz]
    const rows = tweak.noRows ? '' : cell.conductors.map((_, i) => `Row ${i + 1}: N${i}a to N${i}b`).join('\n')
    const block = (f: number) => `Impedance matrix for frequency = ${f} ${n} x ${n}\n` + cell.conductors.map((_, i) => cell.conductors.map((_, j) =>
      i === j ? `${r[i] ?? .01} ${2 * Math.PI * f * 1e-9 * (i + 2)}j` : `${f === modeling.extraction.minimumHz ? tweak.lowMutualR ?? 0 : 0} ${2 * Math.PI * f * 1e-10}j`).join(' ')).join('\n') + '\n'
    return { stdout: 'ok\n', stderr: '', files: { 'Zc.mat': rows + '\n' + frequencies.map(block).join('') } }
  }
}
export function analytic(cell: GeometryCell): number[] {
  return cell.routedCopper ? cell.routedCopper.signals.map(p => p.segments.reduce((s, g) => s + Math.hypot(...g.a.map((v, i) => v - g.b[i])) * 1000 / ((g.conductivitySm ?? cell.conductivitySm) * g.widthMm * g.thicknessMm), 0))
    : cell.conductors.map(c => c.lengthM / ((c.conductivitySm ?? cell.conductivitySm) * (c.parts ?? [c]).reduce((a, p) => a + p.widthM * p.thicknessM, 0)))
}
