// Native output parsers and log scans (was matrices.mjs parseFastHenry/parseFasterCap + extraction.ts checkNativeRun).
import type { DiagnosticInit } from '../kernel'
import type { GeometryCell } from '../board'
import { fail } from './diagnostics'
import type { Matrix } from './linalg'

export interface ImpedanceSample { frequencyHz: number; R: Matrix; L: Matrix }
export interface CapacitanceOutput { names: string[]; matrix: Matrix; units: string }

export function parseFastHenry(text: string): ImpedanceSample[] {
  const blocks=[...text.matchAll(/Impedance matrix for frequency\s*=\s*([\deE+.-]+)\s+(\d+)\s*x\s*(\d+)\s*\n([^]*?)(?=Impedance matrix|$)/g)]
  if(!blocks.length) fail('fasthenry_output','No frequency matrices in Zc.mat')
  return blocks.map(b=>{
    const n=Number(b[2]), rows=b[4].trim().split(/\n/).filter(r=>r.trim()).slice(0,n)
    if(![2,3,4].includes(n) || Number(b[3])!==n) fail('fasthenry_ports', 'One to three signals and one return required')
    const matrix=rows.map(r=>[...r.matchAll(/([+-]?[\d.]+(?:[eE][+-]?\d+)?)\s+([+-]?[\d.]+(?:[eE][+-]?\d+)?)j/g)].map(m=>[Number(m[1]),Number(m[2])]))
    if(matrix.length!==n || matrix.some(r=>r.length!==n)) fail('fasthenry_output','Malformed complex matrix')
    return {frequencyHz:Number(b[1]),R:matrix.map(r=>r.map(v=>v[0])),L:matrix.map(r=>r.map(v=>v[1]/(2*Math.PI*Number(b[1]))))}
  })
}
export function parseFasterCap(text: string): CapacitanceOutput {
  const blocks=[...text.matchAll(/Capacitance matrix is:\s*\nDimension\s+(\d+)\s+x\s+(\d+)\s*\n([^]*?)(?=\n\s*\n|\nTotal|\nMemory|$)/gi)]
  if(!blocks.length) fail('fastercap_output','No 3D capacitance matrix in solver stdout')
  const b=blocks.at(-1)!,n=Number(b[1])
  if(![2,3,4].includes(n) || Number(b[2])!==n) fail('fastercap_ports','Expected 2x2, 3x3 or 4x4 Maxwell matrix')
  const names: string[]=[],matrix=b[3].trim().split('\n').slice(0,n).map(r=>{const parts=r.trim().split(/\s+/);names.push(parts.shift()!);return parts.map(Number)})
  if(matrix.some(r=>r.length!==n || r.some(v=>!Number.isFinite(v)))) fail('fastercap_output','Malformed C matrix')
  return {names,matrix,units:'F (3D FasterCap coordinates in metres)'}
}

/** Both solvers can exhaust GMRES, write finite matrices, and still exit 0: scan their logs. */
export function checkNativeRun(run: {stdout: string; stderr: string}, directory: string, solver: 'fasthenry'|'fastercap', init?: DiagnosticInit): void {
  let output=`${run.stdout}\n${run.stderr}`
  // This platform notice only disables FasterCap's optional out-of-core mode.
  if(solver==='fastercap') output=output.replace(/^\s*Error: cannot retrieve (?:the )?information about (?:the )?free memory quantity\r?\n[ \t]*Cannot go out-of-core, continuing in-core[ \t]*$/gmi,'')
  const lines=output.split(/\r?\n/),name=solver==='fasthenry'?'FastHenry':'FasterCap'
  const unconverged=lines.find(line=>/\b(?:convergence\s+not\s+reached|(?:did\s+not|failed\s+to|not)\s+converg(?:e|ing))\b/i.test(line))
  if(unconverged) fail('native_convergence',`${name}: ${unconverged.trim()}; see ${directory}/${solver}.stdout.log and ${solver}.stderr.log`,init)
  const skipped=solver==='fastercap'&&lines.find(line=>/\bdegenerate\s+(?:quadrilateral|triangular|triangle)\s+panel\b|\bskipping\s+the\s+panel\b/i.test(line))
  if(skipped) fail('native_geometry',`${name}: ${skipped.trim()}; requested copper panels were omitted; see ${directory}/${solver}.stdout.log and ${solver}.stderr.log`,init)
  const failure=lines.find(line=>solver==='fasthenry'
    ? /\b(?:error|fatal|failed|failure|severe warning|internal warning|nonphysical overlap)\b|\bHuh\?|\buh oh, segs don.t seem parallel\b/i.test(line)&&!/^\s*(?:Error tolerance:|Not an error:)/i.test(line)
    : /^\s*(?:(?:error|fatal)\b|(?:severe|internal)\s+(?:warning|error)\b)|\b(?:failed|failure)\b/i.test(line))
  if(failure) fail('native_solver',`${name}: ${failure.trim()}; see ${directory}/${solver}.stdout.log and ${solver}.stderr.log`,init)
}

export function impedanceSamples(text: string, cell: GeometryCell): ImpedanceSample[] {
  for (let i = 0; i < cell.conductors.length; i++) {
    if (!new RegExp(`Row ${i + 1}:\\s+N${i}a\\s+to\\s+N${i}b`, 'i').test(text)) {
      fail('matrix_order', 'FastHenry external port ordering disagrees with declared signals/return')
    }
  }
  const samples: ImpedanceSample[] = parseFastHenry(text)
  for (const sample of samples) {
    if (!Number.isFinite(sample.frequencyHz) || sample.frequencyHz <= 0) fail('model_frequency', 'FastHenry frequency must be finite and positive')
    for (const matrix of [sample.R, sample.L]) {
      if (matrix.length !== cell.conductors.length || matrix.some(row => row.length !== cell.conductors.length || row.some(value => !Number.isFinite(value)))) {
        fail('matrix_dimension', 'FastHenry must report every selected conductor and return')
      }
    }
  }
  return samples
}
