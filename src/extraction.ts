import {fastHenryDeck,fasterCapDeck} from './geometry.js'
import {copperCapacitanceScaleToFarads} from './copper.js'
import {fail,parseFastHenry,parseFasterCap,validateMatrix,loopImpedance,referenceCapacitance,multiply,transpose,sum} from './matrices.mjs'
import {executeSolver, jsonFile, type RunSolver, type FileMap} from './solver.js'
import type {Geometry, GeometryCell, Modeling} from './geometry.js'

type Matrix = number[][]
export interface ImpedanceSample {frequencyHz: number; R: Matrix; L: Matrix}
export interface MatrixCheck {matrix: Matrix; reciprocityResidual: number; cholesky: Matrix}
export interface CapacitanceCheck extends MatrixCheck {denominator: number; convention: string}
export interface RefinementCheck {
  coarseFilaments: number
  refinedFilaments: number
  coarseGroundMeshMm?: number
  refinedGroundMeshMm?: number
  frequencyHz: number
  definition: string
  tolerance: number
  R: number
  L: number
}

function checkNativeRun(run: {stdout: string; stderr: string}, directory: string, solver: 'fasthenry'|'fastercap'): void {
  let output=`${run.stdout}\n${run.stderr}`
  // This platform notice only disables FasterCap's optional out-of-core mode.
  if(solver==='fastercap') output=output.replace(/^\s*Error: cannot retrieve (?:the )?information about (?:the )?free memory quantity\r?\n[ \t]*Cannot go out-of-core, continuing in-core[ \t]*$/gmi,'')
  const lines=output.split(/\r?\n/),name=solver==='fasthenry'?'FastHenry':'FasterCap'
  // Both solvers can exhaust GMRES, write finite matrices, and still exit 0.
  const unconverged=lines.find(line=>/\b(?:convergence\s+not\s+reached|(?:did\s+not|failed\s+to|not)\s+converg(?:e|ing))\b/i.test(line))
  if(unconverged) fail('native_convergence',`${name}: ${unconverged.trim()}; see ${directory}/${solver}.stdout.log and ${solver}.stderr.log`)
  const skipped=solver==='fastercap'&&lines.find(line=>/\bdegenerate\s+(?:quadrilateral|triangular|triangle)\s+panel\b|\bskipping\s+the\s+panel\b/i.test(line))
  if(skipped) fail('native_geometry',`${name}: ${skipped.trim()}; requested copper panels were omitted; see ${directory}/${solver}.stdout.log and ${solver}.stderr.log`)
  const failure=lines.find(line=>solver==='fasthenry'
    ? /\b(?:error|fatal|failed|failure|severe warning|internal warning|nonphysical overlap)\b|\bHuh\?|\buh oh, segs don.t seem parallel\b/i.test(line)&&!/^\s*(?:Error tolerance:|Not an error:)/i.test(line)
    : /^\s*(?:(?:error|fatal)\b|(?:severe|internal)\s+(?:warning|error)\b)|\b(?:failed|failure)\b/i.test(line))
  if(failure) fail('native_solver',`${name}: ${failure.trim()}; see ${directory}/${solver}.stdout.log and ${solver}.stderr.log`)
}

function impedanceSamples(text: string, cell: GeometryCell): ImpedanceSample[] {
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

export async function extractChannel(geometry: Geometry, modeling: Modeling, files: FileMap, runSolver: RunSolver, onProgress: (message: string) => void = () => {}) {
  const extracted=[]
  for(const cell of geometry.cells) {
    onProgress(`Extract stage ${cell.stage} (${cell.profile}) with actual native FastHenry and FasterCap`)
    const dir=`stage-${cell.stage}`
    const coarseFiles={'channel.inp':fastHenryDeck(cell,modeling.extraction)}
    const fc=fasterCapDeck(cell,modeling.extraction)

    const henryArgs=cell.routedCopper?['-p','seg','channel.inp']:['channel.inp']
    const coarseRun=await executeSolver(runSolver,files,dir,{solver:'fasthenry',args:henryArgs,files:coarseFiles,outputFiles:['Zc.mat']})
    checkNativeRun(coarseRun,dir,'fasthenry')
    const ztext=coarseRun.files['Zc.mat']
    const spectrum=impedanceSamples(ztext,cell)
    const lowest=spectrum.reduce((a,b)=>a.frequencyHz<b.frequencyHz?a:b),coarse=spectrum.find(s=>Math.abs(s.frequencyHz/modeling.extraction.modelHz-1)<1e-8)
    if(!coarse) fail('model_frequency','modelHz must be one executed FastHenry sample frequency')
    const refinement=dir+'/refinement'
    const refinedDeck=fastHenryDeck(cell,{...modeling.extraction,minimumHz:modeling.extraction.modelHz,maximumHz:modeling.extraction.modelHz,filaments:modeling.extraction.refinementFilaments,groundMeshMm:modeling.extraction.groundMeshMm===undefined?undefined:modeling.extraction.groundMeshMm/2})
    const refinedRun=await executeSolver(runSolver,files,refinement,{solver:'fasthenry',args:henryArgs,files:{'channel.inp':refinedDeck},outputFiles:['Zc.mat']})
    checkNativeRun(refinedRun,refinement,'fasthenry')
    const refined=impedanceSamples(refinedRun.files['Zc.mat'],cell)
    if(refined.length!==1 || Math.abs(refined[0].frequencyHz/modeling.extraction.modelHz-1)>1e-8) fail('model_frequency','FastHenry refinement must execute exactly modelHz')
    const selected=refined[0]
    const convergence: RefinementCheck={R:0,L:0,coarseFilaments:modeling.extraction.filaments,refinedFilaments:modeling.extraction.refinementFilaments,...(cell.routedCopper?{coarseGroundMeshMm:modeling.extraction.groundMeshMm,refinedGroundMeshMm:modeling.extraction.groundMeshMm!/2}:{}),frequencyHz:selected.frequencyHz,definition:'max(abs(refined-coarse))/max(abs(refined)) for full referenced matrix; routed copper also halves ground mesh spacing',tolerance:modeling.extraction.convergenceTolerance}
    for(const kind of ['R','L'] as const) {
      const a: Matrix=loopImpedance(coarse[kind]),b: Matrix=loopImpedance(selected[kind])
      convergence[kind]=Math.max(...b.flatMap((r,i)=>r.map((v,j)=>Math.abs(v-a[i][j]))))/Math.max(...b.flat().map(Math.abs))
      if(!Number.isFinite(convergence[kind])||convergence[kind]>convergence.tolerance) fail('mesh_convergence',`Stage ${cell.stage} ${kind} refinement residual ${convergence[kind]} > ${convergence.tolerance}; increase filaments and refinementFilaments${cell.routedCopper?' and halve groundMeshMm':''} explicitly`)
    }
    const analytic=cell.routedCopper?cell.routedCopper.signals.map(p=>p.segments.reduce((sum,s)=>sum+Math.hypot(...s.a.map((v,i)=>v-s.b[i]))*1000/((s.conductivitySm??cell.conductivitySm)*s.widthMm*s.thicknessMm),0)):cell.conductors.map(c=>c.lengthM/((c.conductivitySm??cell.conductivitySm)*(c.parts??[c]).reduce((area,p)=>area+p.widthM*p.thicknessM,0)))
    const errors=analytic.map((v,i)=>Math.abs(lowest.R[i][i]/v-1))
    if(errors.some(e=>!Number.isFinite(e)||e>modeling.extraction.dcResistanceTolerance)) fail('analytic_resistance',`DC geometry check failed: errors ${errors.join(',')}`)
    // A polygon plane has no uniform-bar l/(sigma*w*t) resistance. Keep the
    // independent series-resistance check on every signal; plane accuracy is
    // checked by the native ground-mesh refinement above.
    const analyticLoop: Matrix|null=cell.routedCopper?null:loopImpedance(analytic.map((v,i)=>analytic.map((_,j)=>i===j?v:0))),dcLoop: Matrix=loopImpedance(lowest.R)
    const dcLoopResidual=analyticLoop?Math.max(...dcLoop.flatMap((r,i)=>r.map((v,j)=>Math.abs(v-analyticLoop[i][j]))))/Math.max(...analyticLoop.flat()):null
    if(dcLoopResidual!==null&&(!Number.isFinite(dcLoopResidual)||dcLoopResidual>modeling.extraction.dcResistanceTolerance)) fail('analytic_return',`Shared-return DC resistance mismatch ${dcLoopResidual}`)
    const R: MatrixCheck=validateMatrix(loopImpedance(selected.R),'R loop',modeling.extraction.reciprocityTolerance),L: MatrixCheck=validateMatrix(loopImpedance(selected.L),'L loop',modeling.extraction.reciprocityTolerance)
    validateMatrix(selected.R,'R primitive',modeling.extraction.reciprocityTolerance);validateMatrix(selected.L,'L primitive',modeling.extraction.reciprocityTolerance)
    const capRun=await executeSolver(runSolver,files,dir,{solver:'fastercap',args:['channel.lst','-b',`-a${modeling.extraction.capTolerance}`,...(cell.routedCopper?['-ap']:[]),'-e'],files:fc,outputFiles:[]})
    checkNativeRun(capRun,dir,'fastercap')
    const cap: {names: string[]; matrix: Matrix}=parseFasterCap(capRun.stdout)
    const capacitanceScaleToFarads=cell.routedCopper?copperCapacitanceScaleToFarads:1
    cap.matrix=cap.matrix.map(row=>row.map(value=>value*capacitanceScaleToFarads))
    const capDiff=[...capRun.stdout.matchAll(/Weighted Frobenius norm of the difference between capacitance \(auto option\):\s*([\deE+.-]+)/g)].at(-1)
    const capConvergence=capDiff?Number(capDiff[1]):null
    if(capConvergence===null||!Number.isFinite(capConvergence)||capConvergence<0||capConvergence>modeling.extraction.capTolerance) fail('cap_convergence','FasterCap did not report converged automatic refinement within requested tolerance')
    if(cap.names.length!==cell.conductors.length||cap.matrix.length!==cell.conductors.length||!cap.names.every((n,i)=>n.endsWith(`_${cell.conductors[i].name}`))) fail('matrix_order',`FasterCap C conductor ordering changed: ${cap.names}`)
    const primitiveC: MatrixCheck=validateMatrix(cap.matrix,'C primitive',modeling.extraction.reciprocityTolerance),C: CapacitanceCheck=referenceCapacitance(primitiveC.matrix)
    if(primitiveC.matrix.some((r,i)=>sum(r)<=0||r.some((v,j)=>i!==j&&v>0))) fail('capacitance_sign','Primitive Maxwell matrix needs nonpositive off-diagonals and positive capacitance to infinity')
    const cr=primitiveC.matrix.map(sum),v=cell.conductors.slice(0,-1).map((_,i)=>i===0?1.2:-.7),offset=-sum(v.map((value,i)=>cr[i]*value))/C.denominator,full=v.map(value=>[value+offset]).concat([[offset]]),q: Matrix=multiply(primitiveC.matrix,full)
    const energy=multiply(transpose(full),q)[0][0],reducedEnergy=multiply(multiply([v],C.matrix),transpose([v]))[0][0]
    const energyResidual=Math.abs(energy-reducedEnergy)/Math.abs(energy),neutralityResidual=Math.abs(sum(q.flat()))/Math.max(...q.flat().map(Math.abs))
    if(!Number.isFinite(energyResidual)||!Number.isFinite(neutralityResidual)||energyResidual>1e-10||neutralityResidual>1e-10) fail('reference_energy','Neutral finite-return charge/energy reconstruction failed')
    const result={stage:cell.stage,profile:cell.profile,R:R.matrix,L:L.matrix,C:C.matrix,units:{R:'ohm',L:'H',C:'F'},frequencyHz:selected.frequencyHz,primitiveOrder:cell.conductors.map(c=>c.name),primitiveImpedance:spectrum,modelPrimitiveImpedance:selected,primitiveCapacitance:cap.matrix,checks:{R,L,C,primitiveC,convergence,capConvergence,analyticResistanceOhm:analytic,analyticResistanceRelativeErrors:errors,analyticFrequencyHz:lowest.frequencyHz,analyticLoopResistanceOhm:analyticLoop,dcLoopResidual,energyResidual,neutralityResidual},conversions:{impedance:'R=Re(Z), L=Im(Z)/(2*pi*f); A=[I;-ones]; loop=A^T primitive A',capacitance:C.convention,capacitanceSolverCoordinateUnits:cell.routedCopper?'mm':'m',capacitanceScaleToFarads,neutralityDenominatorF:C.denominator}}
    jsonFile(files,dir+'/extraction.json',result);extracted.push(result)
  }
  return extracted
}
