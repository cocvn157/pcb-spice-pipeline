// Dense real matrices (was matrices.mjs sum/scale/transpose/multiply/symmetrize).
export type Matrix = number[][]
export const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0)
export const scale = (a: Matrix, k: number): Matrix => a.map(r => r.map(v => v * k))
export const transpose = (a: Matrix): Matrix => a[0].map((_, j) => a.map(r => r[j]))
export const multiply = (a: Matrix, b: Matrix): Matrix => a.map(r => transpose(b).map(c => sum(r.map((v, k) => v * c[k]))))
export const symmetrize = (a: Matrix): Matrix => a.map((r, i) => r.map((v, j) => (v + a[j][i]) / 2))
