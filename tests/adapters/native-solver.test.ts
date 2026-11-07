// Fault injection at each step of the native solver lifecycle (ARCHITECTURE.md, Verification).
// os.tmpdir() reads TMPDIR on every call, so each test points it at a private directory: any
// workdir the adapter creates lands there, and "cleaned up" means that directory is empty again.
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readdir,readFile,rm,stat,symlink,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createNativeSolver,loadIbisSources} from '../../src/adapters/index.js'
import {invoke} from '../../src/solver/index.js'
import {rootScope} from '../../src/kernel/index.js'

type T={after:(fn:()=>Promise<void>|void)=>void}
const sandbox=async(t: T)=>{
  const root=await mkdtemp(join(tmpdir(),'pcb-adapters-test-')),tmp=join(root,'tmp'),previous=process.env.TMPDIR
  await mkdir(tmp);process.env.TMPDIR=tmp
  assert.equal(tmpdir(),tmp)
  t.after(async()=>{if(previous===undefined) delete process.env.TMPDIR; else process.env.TMPDIR=previous;await rm(root,{recursive:true,force:true})})
  // The fake tool records its cwd outside the workdir, so we can assert that exact dir is gone.
  const cwdFile=join(root,'cwd.txt'),tool=(body: string)=>[ '-e',`require('node:fs').writeFileSync(${JSON.stringify(cwdFile)},process.cwd());${body}`]
  const workdirGone=async()=>{
    assert.deepEqual(await readdir(tmp),[])
    await assert.rejects(stat(await readFile(cwdFile,'utf8')),{code:'ENOENT'})
  }
  return {root,tmp,tool,cwdFile,workdirGone}
}
const code=(expected: string,message?: RegExp)=>(error: unknown)=>{
  assert.equal((error as {code:string}).code,expected)
  if(message) assert.match((error as Error).message,message)
  return true
}

test('unsafe input or output path is rejected before any workdir exists',async t=>{
  const {tmp}=await sandbox(t),solver=createNativeSolver({tools:{ngspice:process.execPath}})
  for(const files of [{'../escape':'x'},{'/abs':'x'},{'a/./b':'x'},{'a\\b':'x'},{'c:x':'x'},{'':'x'}] as Record<string,string>[])
    await assert.rejects(solver({solver:'ngspice',files,args:['-e',''],outputFiles:[]}),code('file_path',/Expected a safe project-relative file path/))
  await assert.rejects(solver({solver:'ngspice',files:{},args:['-e',''],outputFiles:['../out']}),code('file_path'))
  await assert.rejects(solver({solver:'spice' as 'ngspice',files:{},args:[],outputFiles:[]}),code('native_solver',/Unknown solver/))
  assert.deepEqual(await readdir(tmp),[])
})

test('input write failure after mkdtemp still removes the workdir',async t=>{
  const {tmp}=await sandbox(t),solver=createNativeSolver({tools:{ngspice:process.execPath}})
  // 'a' is written as a file, then 'a/b' needs it to be a directory.
  await assert.rejects(solver({solver:'ngspice',files:{'a':'x','a/b':'y'},args:['-e',''],outputFiles:[]}),{code:'EEXIST'})
  assert.deepEqual(await readdir(tmp),[])
})

test('spawn failure (nonexistent tool) rejects native_solver and removes the workdir',async t=>{
  const {root,tmp}=await sandbox(t),solver=createNativeSolver({tools:{fasthenry:join(root,'no-such-tool')}})
  await assert.rejects(solver({solver:'fasthenry',files:{'in.inp':'x'},args:[],outputFiles:['Zc.mat']}),code('native_solver',/^native_solver: fasthenry: .*ENOENT/))
  assert.deepEqual(await readdir(tmp),[])
})

test('nonzero exit rejects native_solver with logs and removes the workdir',async t=>{
  const {tool,workdirGone}=await sandbox(t),solver=createNativeSolver({tools:{ngspice:process.execPath}})
  await assert.rejects(solver({solver:'ngspice',files:{'deck.cir':'x'},args:tool(`process.stdout.write('out');process.stderr.write('err');process.exit(3)`),outputFiles:[]}),
    code('native_solver',/ngspice: Command failed[\s\S]*\nout\nerr$/))
  await workdirGone()
})

test('timeout kills the tool, rejects native_timeout and removes the workdir',async t=>{
  const {root,tool,workdirGone}=await sandbox(t),marker=join(root,'survived.txt')
  const solver=createNativeSolver({tools:{fastercap:process.execPath},timeoutMs:200})
  const started=Date.now()
  await assert.rejects(solver({solver:'fastercap',files:{'deck.lst':'x'},args:tool(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'x'),1500)`),outputFiles:['out.txt']}),
    code('native_timeout',/^native_timeout: fastercap: exceeded 200 ms process timeout; /))
  assert.ok(Date.now()-started<1500)
  await workdirGone()
  await new Promise(done=>setTimeout(done,1600))
  await assert.rejects(stat(marker),{code:'ENOENT'})  // killed, not merely abandoned
})

test('missing requested output is omitted (solver.invoke rejects native_output) and the workdir is removed',async t=>{
  const {tool,workdirGone}=await sandbox(t),solver=createNativeSolver({tools:{ngspice:process.execPath}})
  const request={solver:'ngspice' as const,files:{'deck.cir':'x'},args:tool(`require('node:fs').writeFileSync('extra.dat','e')`),outputFiles:['waveform.dat']}
  const result=await solver(request)
  assert.deepEqual(Object.keys(result.files),[])  // only requested outputs are read; extra.dat is not
  await workdirGone()
  await assert.rejects(invoke({runSolver:solver,progress:()=>{}},rootScope('simulation'),request),code('native_output',/ngspice: missing waveform.dat/))
  await workdirGone()
})

test('requested output that is a symlink out of the workdir rejects file_path and removes the workdir',async t=>{
  const {root,tool,workdirGone}=await sandbox(t),secret=join(root,'secret.txt')
  await writeFile(secret,'secret')
  const solver=createNativeSolver({tools:{ngspice:process.execPath}})
  await assert.rejects(solver({solver:'ngspice',files:{},args:tool(`require('node:fs').symlinkSync(${JSON.stringify(secret)},'out.dat')`),outputFiles:['out.dat']}),
    code('file_path',/File must remain inside/))
  await workdirGone()
})

test('loadIbisSources rejects traversal and symlinks escaping baseDir, follows contained symlinks',async t=>{
  const {root}=await sandbox(t),baseDir=join(root,'project'),outside=join(root,'outside.ibs')
  await mkdir(join(baseDir,'models'),{recursive:true});await writeFile(outside,'[IBIS Ver] 5.0')
  const declare=(path: string)=>[{type:'simulation_ibis_model',simulation_ibis_model_id:'m',ibis_model_asset:{project_relative_path:path}}] as never
  await assert.rejects(loadIbisSources({circuitJson:declare('../outside.ibs'),baseDir}),code('file_path',/Expected a safe project-relative file path: \.\.\/outside\.ibs/))
  await symlink(outside,join(baseDir,'models/file.ibs'))
  await assert.rejects(loadIbisSources({circuitJson:declare('models/file.ibs'),baseDir}),code('file_path',/File must remain inside/))
  await symlink(root,join(baseDir,'up'))  // directory symlink escaping baseDir
  await assert.rejects(loadIbisSources({circuitJson:declare('up/outside.ibs'),baseDir}),code('file_path'))
  await writeFile(join(baseDir,'real.ibs'),'inside');await symlink(join(baseDir,'real.ibs'),join(baseDir,'models/link.ibs'))
  const sources=await loadIbisSources({circuitJson:declare('models/link.ibs'),baseDir})
  assert.equal(new TextDecoder().decode(sources['models/link.ibs'] as Uint8Array),'inside')
})
