import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {runPipeline,generateReport} from '../dist/index.js'
import {createNativeSolver,loadIbisSources,writePipelineOutput} from '../dist/node.js'
import {channelSpice} from '../src/extraction/index.js'
import {inMemoryInput} from './fixtures/in-memory.mjs'

const root=fileURLToPath(new URL('../',import.meta.url))
const output=join(root,'runs','native-library-regression')
const solver=createNativeSolver({tools:{fasthenry:process.env.PCB_SPICE_FASTHENRY??'fasthenry',
  fastercap:process.env.PCB_SPICE_FASTERCAP??'FasterCap',ngspice:process.env.PCB_SPICE_NGSPICE??'ngspice'}})

test('native three-signal channel obeys the complete R + j*w*L impedance matrix and Maxwell C',async()=>{
  const dir=join(output,'three-signal-matrix')
  await mkdir(dir,{recursive:true})
  const R=[[2,.3,.4],[.3,3,.5],[.4,.5,4]]
  const L=[[4e-9,1e-9,.8e-9],[1e-9,5e-9,1.2e-9],[.8e-9,1.2e-9,6e-9]]
  const C=[[5e-12,-1e-12,-.5e-12],[-1e-12,6e-12,-.8e-12],[-.5e-12,-.8e-12,7e-12]]
  const currents=[.001,.002,.004]
  const voltage=[1,2,3]
  const frequency=1e8
  // Independent AC columns: grounded outputs reveal series Z; open outputs reveal shunt C.
  const deck=['Matrix regression',channelSpice([{R,L,C}],1)]
  for(let i=0;i<3;i++) deck.push(`IR${i} 0 in${i} AC ${currents[i]}`,`VC${i} c${i} 0 AC ${voltage[i]}`)
  deck.push('XR in0 in1 in2 0 0 0 0 CHANNEL','XC c0 c1 c2 open0 open1 open2 0 CHANNEL','.control','set wr_singlescale','set wr_vecnames',`ac lin 1 ${frequency} ${frequency}`,'wrdata result.dat v(in0) v(in1) v(in2) i(VC0) i(VC1) i(VC2)','quit','.endc','.end')
  await writeFile(join(dir,'matrix.cir'),deck.join('\n')+'\n')
  await writeFile(join(dir,'.spiceinit'),'quit\n')
  const solved=await solver({solver:'ngspice',args:['-n','-b','matrix.cir'],files:{'matrix.cir':deck.join('\n')+'\n','.spiceinit':'quit\n'},outputFiles:['result.dat']})
  const values=solved.files['result.dat'].trim().split(/\r?\n/)[1].trim().split(/\s+/).map(Number)
  const omega=2*Math.PI*frequency
  // Independently solve the complex pi-network: (Z^-1 + j*w*C/2)^-1 * I.
  const complex=(real,imag=0)=>[real,imag]
  const add=(a,b)=>[a[0]+b[0],a[1]+b[1]]
  const mul=(a,b)=>[a[0]*b[0]-a[1]*b[1],a[0]*b[1]+a[1]*b[0]]
  const div=(a,b)=>mul(a,[b[0]/(b[0]**2+b[1]**2),-b[1]/(b[0]**2+b[1]**2)])
  const solve=(matrix,rhs)=>{
    const a=matrix.map((row,i)=>[...row.map(v=>[...v]),[...rhs[i]]])
    for(let i=0;i<3;i++) {
      const pivot=a[i][i]
      a[i]=a[i].map(v=>div(v,pivot))
      for(let j=0;j<3;j++) if(j!==i) {
        const factor=a[j][i]
        a[j]=a[j].map((v,k)=>add(v,mul(complex(-1),mul(factor,a[i][k]))))
      }
    }
    return a.map(row=>row[3])
  }
  const Z=R.map((row,i)=>row.map((v,j)=>complex(v,omega*L[i][j])))
  const admittance=Array.from({length:3},(_,j)=>solve(Z,Array.from({length:3},(_,i)=>complex(Number(i===j)))))
  const Y=C.map((row,i)=>row.map((v,j)=>add(admittance[j][i],complex(0,omega*v/2))))
  const expected=solve(Y,currents.map(v=>complex(v)))
  for(let i=0;i<3;i++) for(let part=0;part<2;part++) assert.ok(Math.abs(values[1+2*i+part]-expected[i][part])<1e-8,'full series impedance, including every mutual term')
  // Open-end voltages require a second complex network solve to include all shunt couplings.
  const openY=C.map((row,i)=>row.map((v,j)=>add(admittance[j][i],complex(0,omega*v/2))))
  const rhs=admittance[0].map((_,i)=>voltage.reduce((s,v,j)=>add(s,mul(admittance[j][i],complex(v))),complex(0)))
  const open=solve(openY,rhs)
  const supplyCurrent=voltage.map((v,i)=>voltage.reduce((s,w,j)=>add(s,add(mul(complex(0,omega*C[i][j]/2),complex(w)),mul(admittance[j][i],add(complex(w),mul(complex(-1),open[j]))))),complex(0)))
  for(let i=0;i<3;i++) for(let part=0;part<2;part++) assert.ok(Math.abs(values[7+2*i+part]+supplyCurrent[i][part])<1e-8,'all Maxwell shunts and mutual capacitors survive')
})

test('full in-memory pipeline executes real extraction, refinement and ngspice before explicit output',async()=>{
  const input=inMemoryInput()
  const calls=[]
  const result=await runPipeline({...input,runSolver:async request=>{
    calls.push(request.solver)
    return solver(request)
  }})
  assert.deepEqual(calls,['fasthenry','fasthenry','fastercap','ngspice'])
  assert.equal(result.matrices.length,1)
  const matrix=result.matrices[0]
  assert.ok(matrix.checks.convergence.R<=input.modeling.extraction.convergenceTolerance)
  assert.ok(matrix.checks.convergence.L<=input.modeling.extraction.convergenceTolerance)
  assert.ok(matrix.checks.energyResidual<1e-10)
  assert.ok(matrix.checks.neutralityResidual<1e-10)
  const run=result.experiments[0]
  assert.equal(run.solverInvocations,1)
  assert.ok(run.waveform.rows.length>100)
  assert.ok(run.eyes.every(eye=>eye.windows>3&&eye.samples.length===eye.windows*1200))
  for(const probe of run.probes) {
    const graph=result.simulationResultCircuitJson.find(record=>record.type==='simulation_transient_voltage_graph'&&record.simulation_voltage_probe_id===probe.simulationVoltageProbeId)
    assert.deepEqual(graph.timestamps_ms,run.waveform.rows.map(row=>row[0]*1000))
    assert.deepEqual(graph.voltage_levels,run.waveform.rows.map(row=>row[probe.column]))
  }
  assert.match(generateReport(result)['results.html'],/Simulation complete/)
  await writePipelineOutput({result,outputDir:join(output,'input-buffer-channel')})
})

// Vendor preparation is explicitly caller-owned. Enable this additional native
// regression only when the exact locally prepared assets are supplied.
test('actual vendor single-ended and differential boards preserve driven data and eye bindings',
  {skip:!process.env.PCB_SPICE_TEST_MODEL_DIR},async()=>{
  for(const name of ['single-ended','differential-data']) {
    const {circuitJson,modeling}=await import(`../examples/${name}/index.circuit.tsx`)
    const ibisSources=await loadIbisSources({circuitJson,baseDir:process.env.PCB_SPICE_TEST_MODEL_DIR})
    const result=await runPipeline({circuitJson,modeling,ibisSources,runSolver:solver})
    for(const run of result.experiments) {
      assert.ok(run.eyes.length>=2)
      for(const probe of run.probes) {
        const values=run.waveform.rows.map(row=>row[probe.column])
        assert.ok(Math.max(...values)-Math.min(...values)>.5)
      }
      assert.ok(run.eyes.every(eye=>eye.windows>3))
    }
    await writePipelineOutput({result,outputDir:join(output,name)})
  }
})
