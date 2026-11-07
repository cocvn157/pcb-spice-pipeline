// Native extraction per geometry cell (was extraction.ts extractChannel + general-pipeline's channel.cir line).
import type { Artifact, ArtifactScope, DiagnosticInit, Produced } from '../kernel'
import { invoke, type AcceptedRun, type SolverContext, type SolverRequest } from '../solver'
import type { Geometry, GeometryCell } from '../board'
import { fail } from './diagnostics'
import { fastHenryDeck, fasterCapDeck, copperCapacitanceScaleToFarads } from './decks'
import { checkNativeRun, impedanceSamples, parseFasterCap } from './parse'
import { validateMatrix, loopImpedance, referenceCapacitance, type MatrixCheck, type CapacitanceCheck } from './checks'
import { multiply, transpose, sum, type Matrix } from './linalg'
import { channelSpice } from './rlgc'
import type { ExtractionModeling, ExtractedChannel, ExtractedStage, RefinementCheck } from './types'

/**
 * Per cell, in stage order, under `<scope>/stage-<N>/`:
 *   fasthenry (coarse) -> stage-N/{channel.inp,Zc.mat,fasthenry.*}
 *   fasthenry at modelHz, refinementFilaments (and halved groundMeshMm) -> stage-N/refinement/...
 *   fastercap -> stage-N/{channel.lst,<conductor>.txt,fastercap.*}
 *   checks (convergence, DC R, reciprocity, passivity, capacitance sign, energy) -> stage-N/extraction.json
 * then `channel.cir` = channelSpice(matrices, sections). Native output only: no fallback path.
 * Bytes and paths are identical to the pre-module pipeline (later writes to a path replace earlier
 * ones, as the old shared FileMap did).
 */
export async function extractChannel(geometry: Geometry, modeling: ExtractionModeling, scope: ArtifactScope, ctx: SolverContext): Promise<Produced<ExtractedChannel>> {
  const files=new Map<string,Artifact>()
  /** Keeps the latest artifact per path, so a later write replaces an earlier one like the old shared FileMap. */
  const record=(artifacts: readonly Artifact[]): void=>{
    for(const a of artifacts) files.set(a.path,a)
  }
  /** Runs one native solver under dir, records its artifacts, and hands back the accepted run. */
  const run=async(dir: ArtifactScope,request: SolverRequest): Promise<AcceptedRun>=>{
    const produced=await invoke(ctx,dir,request)
    record(produced.artifacts)
    return produced.value
  }
  const extracted: ExtractedStage[]=[]
  for(const cell of geometry.cells) {
    ctx.progress(`Extract stage ${cell.stage} (${cell.profile}) with actual native FastHenry and FasterCap`)
    const dir=`stage-${cell.stage}`
    const stageScope=scope.child(dir)
    const subject: DiagnosticInit['subjects']=[{kind:'cell',id:String(cell.stage)}]
    const coarseFiles={'channel.inp':fastHenryDeck(cell,modeling.extraction)}
    const fc=fasterCapDeck(cell,modeling.extraction)

    const henryArgs=cell.routedCopper?['-p','seg','channel.inp']:['channel.inp']
    const coarseRun=await run(stageScope,{solver:'fasthenry',args:henryArgs,files:coarseFiles,outputFiles:['Zc.mat']})
    checkNativeRun(coarseRun,dir,'fasthenry',{subjects:subject,artifacts:coarseRun.logPaths})
    const ztext=coarseRun.files['Zc.mat']
    const spectrum=impedanceSamples(ztext,cell)
    const lowest=spectrum.reduce((a,b)=>a.frequencyHz<b.frequencyHz?a:b)
    const coarse=spectrum.find(s=>Math.abs(s.frequencyHz/modeling.extraction.modelHz-1)<1e-8)
    if(!coarse) fail('model_frequency','modelHz must be one executed FastHenry sample frequency')
    const refinement=dir+'/refinement'
    const refinedDeck=fastHenryDeck(cell,{...modeling.extraction,minimumHz:modeling.extraction.modelHz,maximumHz:modeling.extraction.modelHz,filaments:modeling.extraction.refinementFilaments,groundMeshMm:modeling.extraction.groundMeshMm===undefined?undefined:modeling.extraction.groundMeshMm/2})
    const refinedRun=await run(stageScope.child('refinement'),{solver:'fasthenry',args:henryArgs,files:{'channel.inp':refinedDeck},outputFiles:['Zc.mat']})
    checkNativeRun(refinedRun,refinement,'fasthenry',{subjects:subject,artifacts:refinedRun.logPaths})
    const refined=impedanceSamples(refinedRun.files['Zc.mat'],cell)
    if(refined.length!==1 || Math.abs(refined[0].frequencyHz/modeling.extraction.modelHz-1)>1e-8) fail('model_frequency','FastHenry refinement must execute exactly modelHz')
    const selected=refined[0]
    const convergence: RefinementCheck={R:0,L:0,coarseFilaments:modeling.extraction.filaments,refinedFilaments:modeling.extraction.refinementFilaments,...(cell.routedCopper?{coarseGroundMeshMm:modeling.extraction.groundMeshMm,refinedGroundMeshMm:modeling.extraction.groundMeshMm!/2}:{}),frequencyHz:selected.frequencyHz,definition:'max(abs(refined-coarse))/max(abs(refined)) for full referenced matrix; routed copper also halves ground mesh spacing',tolerance:modeling.extraction.convergenceTolerance}
    for(const kind of ['R','L'] as const) {
      const a: Matrix=loopImpedance(coarse[kind])
      const b: Matrix=loopImpedance(selected[kind])
      convergence[kind]=Math.max(...b.flatMap((r,i)=>r.map((v,j)=>Math.abs(v-a[i][j]))))/Math.max(...b.flat().map(Math.abs))
      if(!Number.isFinite(convergence[kind])||convergence[kind]>convergence.tolerance) fail('mesh_convergence',`Stage ${cell.stage} ${kind} refinement residual ${convergence[kind]} > ${convergence.tolerance}; increase filaments and refinementFilaments${cell.routedCopper?' and halve groundMeshMm':''} explicitly`,{subjects:subject,artifacts:[...coarseRun.logPaths,...refinedRun.logPaths]})
    }
    const analytic: number[]=analyticResistance(cell)
    const errors=analytic.map((v,i)=>Math.abs(lowest.R[i][i]/v-1))
    if(errors.some(e=>!Number.isFinite(e)||e>modeling.extraction.dcResistanceTolerance)) fail('analytic_resistance',`DC geometry check failed: errors ${errors.join(',')}`,{subjects:subject})
    // A polygon plane has no uniform-bar l/(sigma*w*t) resistance. Keep the
    // independent series-resistance check on every signal; plane accuracy is
    // checked by the native ground-mesh refinement above.
    const analyticLoop: Matrix|null=cell.routedCopper?null:loopImpedance(analytic.map((v,i)=>analytic.map((_,j)=>i===j?v:0)))
    const dcLoop: Matrix=loopImpedance(lowest.R)
    const dcLoopResidual=analyticLoop?Math.max(...dcLoop.flatMap((r,i)=>r.map((v,j)=>Math.abs(v-analyticLoop[i][j]))))/Math.max(...analyticLoop.flat()):null
    if(dcLoopResidual!==null&&(!Number.isFinite(dcLoopResidual)||dcLoopResidual>modeling.extraction.dcResistanceTolerance)) fail('analytic_return',`Shared-return DC resistance mismatch ${dcLoopResidual}`,{subjects:subject})
    const R: MatrixCheck=validateMatrix(loopImpedance(selected.R),'R loop',modeling.extraction.reciprocityTolerance)
    const L: MatrixCheck=validateMatrix(loopImpedance(selected.L),'L loop',modeling.extraction.reciprocityTolerance)
    validateMatrix(selected.R,'R primitive',modeling.extraction.reciprocityTolerance)
    validateMatrix(selected.L,'L primitive',modeling.extraction.reciprocityTolerance)
    const capRun=await run(stageScope,{solver:'fastercap',args:['channel.lst','-b',`-a${modeling.extraction.capTolerance}`,...(cell.routedCopper?['-ap']:[]),'-e'],files:fc,outputFiles:[]})
    checkNativeRun(capRun,dir,'fastercap',{subjects:subject,artifacts:capRun.logPaths})
    const cap: {names: string[]; matrix: Matrix}=parseFasterCap(capRun.stdout)
    const capacitanceScaleToFarads=cell.routedCopper?copperCapacitanceScaleToFarads:1
    cap.matrix=cap.matrix.map(row=>row.map(value=>value*capacitanceScaleToFarads))
    const capDiff=[...capRun.stdout.matchAll(/Weighted Frobenius norm of the difference between capacitance \(auto option\):\s*([\deE+.-]+)/g)].at(-1)
    const capConvergence=capDiff?Number(capDiff[1]):null
    if(capConvergence===null||!Number.isFinite(capConvergence)||capConvergence<0||capConvergence>modeling.extraction.capTolerance) fail('cap_convergence','FasterCap did not report converged automatic refinement within requested tolerance',{subjects:subject,artifacts:capRun.logPaths})
    if(cap.names.length!==cell.conductors.length||cap.matrix.length!==cell.conductors.length||!cap.names.every((n,i)=>n.endsWith(`_${cell.conductors[i].name}`))) fail('matrix_order',`FasterCap C conductor ordering changed: ${cap.names}`,{subjects:subject})
    const primitiveC: MatrixCheck=validateMatrix(cap.matrix,'C primitive',modeling.extraction.reciprocityTolerance)
    const C: CapacitanceCheck=referenceCapacitance(primitiveC.matrix)
    if(primitiveC.matrix.some((r,i)=>sum(r)<=0||r.some((v,j)=>i!==j&&v>0))) fail('capacitance_sign','Primitive Maxwell matrix needs nonpositive off-diagonals and positive capacitance to infinity',{subjects:subject})
    const cr=primitiveC.matrix.map(sum)
    const v=cell.conductors.slice(0,-1).map((_,i)=>i===0?1.2:-.7)
    const offset=-sum(v.map((value,i)=>cr[i]*value))/C.denominator
    const full=v.map(value=>[value+offset]).concat([[offset]])
    const q: Matrix=multiply(primitiveC.matrix,full)
    const energy=multiply(transpose(full),q)[0][0]
    const reducedEnergy=multiply(multiply([v],C.matrix),transpose([v]))[0][0]
    const energyResidual=Math.abs(energy-reducedEnergy)/Math.abs(energy)
    const neutralityResidual=Math.abs(sum(q.flat()))/Math.max(...q.flat().map(Math.abs))
    if(!Number.isFinite(energyResidual)||!Number.isFinite(neutralityResidual)||energyResidual>1e-10||neutralityResidual>1e-10) fail('reference_energy','Neutral finite-return charge/energy reconstruction failed',{subjects:subject})
    const result: ExtractedStage={stage:cell.stage,profile:cell.profile,R:R.matrix,L:L.matrix,C:C.matrix,units:{R:'ohm',L:'H',C:'F'},frequencyHz:selected.frequencyHz,primitiveOrder:cell.conductors.map(c=>c.name),primitiveImpedance:spectrum,modelPrimitiveImpedance:selected,primitiveCapacitance:cap.matrix,checks:{R,L,C,primitiveC,convergence,capConvergence,analyticResistanceOhm:analytic,analyticResistanceRelativeErrors:errors,analyticFrequencyHz:lowest.frequencyHz,analyticLoopResistanceOhm:analyticLoop,dcLoopResidual,energyResidual,neutralityResidual},conversions:{impedance:'R=Re(Z), L=Im(Z)/(2*pi*f); A=[I;-ones]; loop=A^T primitive A',capacitance:C.convention,capacitanceSolverCoordinateUnits:cell.routedCopper?'mm':'m',capacitanceScaleToFarads,neutralityDenominatorF:C.denominator}}
    record([stageScope.json('extraction.json',result)])
    extracted.push(result)
  }
  const spice=channelSpice(extracted,modeling.sections)
  record([scope.text('channel.cir',spice)])
  return {value:{matrices:extracted,spice},artifacts:[...files.values()]}
}

/** Independent l/(sigma*w*t) series resistance per conductor (routed: per signal path, mm segments). */
function analyticResistance(cell: GeometryCell): number[] {
  return cell.routedCopper?cell.routedCopper.signals.map(p=>p.segments.reduce((sum,s)=>sum+Math.hypot(...s.a.map((v,i)=>v-s.b[i]))*1000/((s.conductivitySm??cell.conductivitySm)*s.widthMm*s.thicknessMm),0)):cell.conductors.map(c=>c.lengthM/((c.conductivitySm??cell.conductivitySm)*(c.parts??[c]).reduce((area,p)=>area+p.widthM*p.thicknessM,0)))
}
