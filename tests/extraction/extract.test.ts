import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {rootScope,type FileMap} from '../../src/kernel'
import type {RunSolver,SolverContext,SolverRequest,SolverResult} from '../../src/solver'
import {extractChannel,type ExtractedStage} from '../../src/extraction'
import {geometryFromCircuitJson} from '../../src/board'
import {groundPlaneFixture} from '../fixtures/ground-plane'

/** A solver context that uses the given fake solver and discards progress messages. */
const context=(runSolver: RunSolver): SolverContext=>({runSolver,progress:()=>{}})
/** Runs extraction, copies every artifact body into files for inspection, and returns the stage matrices. */
const extract=async(...[geometry,modeling,files,runSolver]: [Parameters<typeof extractChannel>[0],Parameters<typeof extractChannel>[1],FileMap,RunSolver]): Promise<ExtractedStage[]>=>{
  const {value,artifacts}=await extractChannel(geometry,modeling,rootScope('extraction'),context(runSolver))
  for(const artifact of artifacts) files[artifact.path]=artifact.body
  return value.matrices
}

test('FastHenry exit 0 cannot hide failed GMRES or numerical errors in either run', async t=>{
  for(const phase of ['coarse','refinement']) for(const diagnostic of [
    {stream:'stdout',message:'Warning: Convergence not reached. Stopping iteration...',code:'native_convergence'},
    {stream:'stderr',message:'Internal error in dist_betw_fils: D1D1 too small!',code:'native_solver'},
    {stream:'stderr',message:'Huh?  filament not expected length',code:'native_solver'},
    {stream:'stdout',message:"uh oh, segs don't seem parallel 2.76752e-12",code:'native_solver'},
  ]) await t.test(`${phase}: ${diagnostic.code}`,async t=>{
    let calls=0
    /** Fake FastHenry: valid matrices, with the diagnostic injected into the coarse or refinement run's log. */
    const solver:RunSolver=async(): Promise<SolverResult>=>{
      const refined=calls++===1
      return {stdout:'Error tolerance: 0.001\nNot an error: Two adjacent gp segs not in same gp a, b.\n',stderr:'',
        ...((refined===(phase==='refinement'))?{[diagnostic.stream]:diagnostic.message}:{}),
        files:{'Zc.mat':'Row 1: N0a to N0b\nRow 2: N1a to N1b\nRow 3: N2a to N2b\nImpedance matrix for frequency = 1e+08 3 x 3\n1 1j 0 0j 0 0j\n0 0j 1 1j 0 0j\n0 0j 0 0j 1 1j\n'}}
    }
    const {circuit,modeling}=groundPlaneFixture()
    const geometry=geometryFromCircuitJson(circuit,modeling)
    await assert.rejects(extract(geometry,modeling,{},solver),error=>{
      assert.equal((error as {code:string}).code,diagnostic.code)
      assert.ok((error as Error).message.includes(diagnostic.message))
      if(phase==='refinement') assert.match((error as Error).message,/refinement\/fasthenry\.stdout\.log/)
      return true
    })
  })
})

test('FasterCap failures override its mesh report; routed mm and legacy m results preserve physical capacitance',async t=>{
  for(const stream of ['stdout','stderr','degenerate quadrilateral','degenerate triangular','benign','legacy']) await t.test(stream,async t=>{
    const legacy=stream==='legacy'
    const fails=stream!=='benign'&&!legacy
    const skips=stream.startsWith('degenerate')
    const failure=skips?`Warning: ${stream} panel found (co-linear vertexes)\n         Skipping the panel`:'Error: not converging after 1000 iterations, norm of the residual is 0.035, while targeting 0.010'
    // A 10 mm × 0.1 mm × 35 µm copper signal has R=0.0492610837 Ω.
    // Keep the fake native R/L valid so these cases exercise FasterCap's logs.
    const impedance=`Row 1: N0a to N0b\nRow 2: N1a to N1b\nRow 3: N2a to N2b\nImpedance matrix for frequency = 1e+08 3 x 3\n0.0492610837 1j 0 0j 0 0j\n0 0j 0.0492610837 1j 0 0j\n0 0j 0 0j ${legacy?.002463054187:.01} 1j\n`
    const exponent=legacy?'e-12':'e-9'
    const capacitance=`Auto calculation with max error: 0.02\nError: cannot retrieve the information about the free memory quantity\n       Cannot go out-of-core, continuing in-core\nWarning: thin triangles (min angle less than 1 degrees) created in the triangulation of a quadrilateral panel\nCapacitance matrix is:\nDimension 3 x 3\ng_sig0 4${exponent} -1${exponent} -1${exponent}\ng_sig1 -1${exponent} 4${exponent} -1${exponent}\ng_return -1${exponent} -1${exponent} 4${exponent}\n\nWeighted Frobenius norm of the difference between capacitance (auto option): 0.001\n`
    /** Fake solvers: valid FastHenry output, FasterCap output with the case's failure or benign notices in its logs. */
    const solver:RunSolver=async (request: SolverRequest): Promise<SolverResult>=>request.solver==='fastercap'
      ?{stdout:capacitance+(fails&&stream!=='stderr'?failure:''),stderr:fails&&stream==='stderr'?failure:'',files:{} as FileMap}
      :{stdout:'',stderr:'',files:{'Zc.mat':impedance}}
    const files:FileMap={}
    const {circuit,modeling:copperModeling}=groundPlaneFixture()
    const modeling=legacy?JSON.parse(await readFile(new URL('../fixtures/straight.modeling.json',import.meta.url),'utf8')):copperModeling
    const geometry=geometryFromCircuitJson(circuit,modeling)
    const extraction=extract(geometry,modeling,files,solver)
    if(fails) await assert.rejects(extraction,error=>{
      assert.equal((error as {code:string}).code,skips?'native_geometry':'native_convergence')
      assert.ok((error as Error).message.includes(failure.split('\n')[0]))
      return true
    })
    else {
      const [result]=await extraction
      assert.equal(result.checks.convergence.coarseGroundMeshMm,legacy?undefined:.5)
      assert.equal(result.checks.convergence.refinedGroundMeshMm,legacy?undefined:.25)
      assert.equal(result.conversions.capacitanceSolverCoordinateUnits,legacy?'m':'mm')
      assert.equal(result.conversions.capacitanceScaleToFarads,legacy?1:1e-3)
      assert.ok(Math.abs(result.primitiveCapacitance[0][0]-4e-12)<1e-24)
      assert.ok(Math.abs(result.C[0][0]-10e-12/3)<1e-24)
      for(const phase of ['', 'refinement']) {
        const record=JSON.parse(files[`stage-0/${phase?phase+'/':''}fasthenry.request.json`])
        assert.deepEqual(record.args,legacy?['channel.inp']:['-p','seg','channel.inp'])
      }
      const capRecord=JSON.parse(files['stage-0/fastercap.request.json'])
      assert.deepEqual(capRecord.args,['channel.lst','-b','-a0.02',...(legacy?[]:['-ap']),'-e'])
    }
  })
})
