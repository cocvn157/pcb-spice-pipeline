// Copied from tests/node.test.ts, repointed at src/adapters. Assertions unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,stat} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createNativeSolver,loadIbisSources,writePipelineOutput} from '../../src/adapters'
import {runPipeline} from '../../src/pipeline'
import {generateReport} from '../../src/report'
import type {RunSolver} from '../../src/solver'
import {inMemoryInput,fixtureSolver} from '../fixtures/in-memory.mjs'

const temporary=async(t: {after:(fn:()=>Promise<void>)=>void})=>{
  const path=await mkdtemp(join(tmpdir(),'pcb-node-test-'));t.after(()=>rm(path,{recursive:true,force:true}));return path
}
test('native adapter isolates requests, captures files and logs, and cleans up success and failure',async t=>{
  const root=await temporary(t),entry=join(root,'solver.mjs'),location=join(root,'location.txt')
  await writeFile(entry,`import {readFileSync,writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(location)},process.cwd());process.stdout.write('ran');process.stderr.write('notice');if(process.argv.includes('signal'))process.kill(process.pid,'SIGTERM');if(process.argv.includes('fail'))process.exit(7);if(process.argv.includes('timeout'))setTimeout(()=>{},5000);else writeFileSync('output.dat',readFileSync('nested/input.dat','utf8'));`)
  const solver=createNativeSolver({tools:{ngspice:process.execPath},timeoutMs:1000})
  const request={solver:'ngspice' as const,files:{'nested/input.dat':'exact input\r\n'},args:[entry],outputFiles:['output.dat']}
  const output=await solver(request)
  assert.deepEqual(output.stdout,'ran');assert.deepEqual(output.stderr,'notice')
  assert.equal(output.files['output.dat'],'exact input\r\n')
  const cwd=await readFile(location,'utf8');await assert.rejects(stat(cwd),{code:'ENOENT'})
  await assert.rejects(solver({...request,args:[entry,'fail']}),/native_solver.*Command failed/)
  await assert.rejects(stat(await readFile(location,'utf8')),{code:'ENOENT'})
  await assert.rejects(solver({...request,args:[entry,'signal']}),/native_solver/)
  await assert.rejects(solver({...request,args:[entry,'timeout']}),error=>{
    assert.equal((error as {code:string}).code,'native_timeout')
    assert.match((error as Error).message,/ngspice.*1000 ms/)
    assert.match((error as Error).message,/ran[\s\S]*notice/)
    return true
  })
  await assert.rejects(stat(await readFile(location,'utf8')),{code:'ENOENT'})
  await assert.rejects(solver({...request,files:{'../escape':'bad'}}),/file_path/)
  assert.throws(()=>createNativeSolver({timeoutMs:0}),/native_timeout/)
})
test('local IBIS loading deduplicates declarations, rejects missing files and symlink escapes',async t=>{
  const root=await temporary(t),baseDir=join(root,'project'),outside=join(root,'outside.ibs')
  await mkdir(join(baseDir,'models'),{recursive:true})
  const input=inMemoryInput(),bytes=input.ibisSources['models/test.ibs']
  await writeFile(join(baseDir,'models/test.ibs'),bytes)
  assert.deepEqual(await loadIbisSources({circuitJson:input.circuitJson,baseDir}),Object.assign(Object.create(null),{'models/test.ibs':bytes}))
  await rm(join(baseDir,'models/test.ibs'))
  await assert.rejects(loadIbisSources({circuitJson:input.circuitJson,baseDir}),{code:'ENOENT'})
  await writeFile(outside,bytes);await symlink(outside,join(baseDir,'models/test.ibs'))
  await assert.rejects(loadIbisSources({circuitJson:input.circuitJson,baseDir}),/file_path/)
})
test('explicit output writes supplied artifacts plus the in-memory report without invoking solvers',async t=>{
  const outputDir=await temporary(t),result=await runPipeline({...inMemoryInput(),runSolver:fixtureSolver as RunSolver})
  const report=generateReport(result)
  await writePipelineOutput({result,outputDir})
  for(const [path,body] of Object.entries({...result.files,...report})) assert.equal(await readFile(join(outputDir,path),'utf8'),body)
  result.files['../escape']='bad'
  await assert.rejects(writePipelineOutput({result,outputDir}),/file_path/)
})
