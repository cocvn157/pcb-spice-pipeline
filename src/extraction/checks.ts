// Reciprocity / passivity / reference reduction (was matrices.mjs validateMatrix/loopImpedance/referenceCapacitance).
import { fail } from './diagnostics'
import { multiply, sum, symmetrize, transpose, type Matrix } from './linalg'

export interface MatrixCheck { matrix: Matrix; reciprocityResidual: number; cholesky: Matrix }
export interface CapacitanceCheck extends MatrixCheck { denominator: number; convention: string }

/** Rejects a matrix that is not finite, square, reciprocal within tolerance and positive definite; returns its symmetric part and Cholesky factor as proof. */
export function validateMatrix(a: Matrix, name: string, tolerance: number = 0.02): MatrixCheck {
  const n=a.length
  if (!n || a.some(r => r.length!==n || r.some(v => !Number.isFinite(v)))) fail('matrix_format', `${name}: finite square matrix required`)
  const norm=Math.max(...a.flat().map(Math.abs))
  if (!norm) fail('matrix_zero',name)
  const residual=Math.max(...a.flatMap((r,i) => r.map((v,j) => Math.abs(v-a[j][i]))))/norm
  if (residual>tolerance) fail('reciprocity', `${name}: residual ${residual} > ${tolerance}`)
  const m=symmetrize(a)
  const l: Matrix=m.map(() => Array(n).fill(0))
  for(let i=0;i<n;i++) for(let j=0;j<=i;j++) {
    const v=m[i][j]-sum(l[i].slice(0,j).map((x,k)=>x*l[j][k]))
    if(i===j) {
      if(v<=norm*1e-12) fail('passivity', `${name}: nonpositive Cholesky pivot ${v}`)
      l[i][j]=Math.sqrt(v)
    } else l[i][j]=v/l[j][j]
  }
  return {matrix:m,reciprocityResidual:residual,cholesky:l}
}
/** Reduces an (n+1)-conductor impedance matrix to n signal loops that each return through the last conductor. */
export function loopImpedance(a: Matrix): Matrix {
  const n=a.length-1
  if(![1,2,3].includes(n)) fail('matrix_dimension','One to three signals plus a return required')
  const A=Array.from({length:n+1},(_,i)=>Array.from({length:n},(_,j)=>i===n?-1:Number(i===j)))
  return multiply(multiply(transpose(A),a),A)
}
/** Turns a Maxwell capacitance matrix referenced to infinity into one referenced to the finite return conductor, then checks its signs. */
export function referenceCapacitance(c: Matrix): CapacitanceCheck {
  const row=c.map(sum)
  const denominator=sum(row)
  if(denominator<=0) fail('reference', 'C to infinity must have positive total common capacitance')
  const n=c.length-1
  const matrix=c.slice(0,n).map((r,i)=>r.slice(0,n).map((v,j)=>v-row[i]*row[j]/denominator))
  const checked=validateMatrix(matrix,'C loop')
  if(checked.matrix.some((r,i)=>r.some((v,j)=>i!==j&&v>0)||sum(r)<=0)) fail('capacitance_sign', 'Referenced Maxwell C needs nonpositive mutual C and positive shunt C')
  return {...checked,denominator,convention:'Q_total=0; Vsignal relative to finite return; infinity common voltage eliminated'}
}
