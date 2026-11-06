import {modelingFromCircuitJson} from './modeling.js'
import * as converter from '@tscircuit/ibis-to-spice'
import type {CircuitJson} from './schema.js'
import {parseRecord} from './schema.js'
import {geometryFromCircuitJson,type Modeling} from './geometry.js'
import {generalDeclarations,modelRunDefinition} from './declarations.js'
import {electricalSources,generalSimulationSpice,validateProbeScope} from './general-spice.js'
import {channelSpice} from './spice.js'
import {extractChannel} from './extraction.js'
import {probeWaveformRows,foldProbeEye} from './metrics.mjs'
import {resolveDdrAssessments,assessDdr} from './ddr.js'
import {sha256} from './hash.js'
import {fail} from './matrices.mjs'
import {loadModelSource,type IbisSources} from './model-source.js'
import {executeSolver,jsonFile,type FileMap,type RunSolver} from './solver.js'
import {validateCircuitRecords} from './circuit-schema.mjs'

export type PipelineModeling = Modeling & { ibisModelAssetSha256?: Record<string,string> }
export interface PipelineOptions {
  circuitJson: CircuitJson
  modeling?: PipelineModeling
  ibisSources: IbisSources
  runSolver: RunSolver
  onProgress?: (message: string) => void
}
const safeId=(id: string): string=>{
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]+$/.test(id)) fail('simulation_id','Serialized simulation IDs must be safe stable identifiers')
  return id
}

/** Deterministic orchestration. All external execution belongs to the supplied callback. */
export async function runPipeline({circuitJson,modeling,ibisSources,runSolver,onProgress=()=>{}}: PipelineOptions) {
  modeling ??= modelingFromCircuitJson(circuitJson)
  validateCircuitRecords(circuitJson)
  if(typeof converter.convertIbisModelToSpice!=='function') fail('converter_version','Install the pinned upstream general IBIS converter')
  const geometry=geometryFromCircuitJson(circuitJson,modeling),declarations=generalDeclarations(circuitJson,geometry,modeling)
  const ddrAssessments=resolveDdrAssessments(declarations.plans,geometry,modeling.ddrAssessments)
  const electrical=electricalSources(circuitJson,modeling,declarations.nodes)
  for(const plan of declarations.plans) {safeId(plan.simulationExperimentId);for(const eye of plan.eyes) safeId(eye.simulationEyeDiagramId)}
  // Validate every source, buffer state and observation before spending solver work.
  const expectedHashes=modeling.ibisModelAssetSha256
  if(expectedHashes!==undefined&&(!expectedHashes||typeof expectedHashes!=='object'||Array.isArray(expectedHashes))) fail('vendor_hash','modeling.ibisModelAssetSha256 must map project-relative IBIS asset paths to SHA-256 hashes')
  const loaded: ReturnType<typeof loadModelSource>[]=[]
  for(const model of declarations.models) {
    const path=model.ibis_model_asset.project_relative_path
    let expected: string | undefined
    if(expectedHashes!==undefined) {
      expected=expectedHashes[path]
      if(typeof expected!=='string'||!/^[a-f0-9]{64}$/i.test(expected)) fail('vendor_hash',`${path}: modeling.ibisModelAssetSha256 requires an expected 64-digit SHA-256 hash for each used IBIS asset`)
    }
    const source=loadModelSource(model,ibisSources)
    if(expected!==undefined&&source.evidence.sourceSha256!==expected.toLowerCase()) fail('vendor_hash',`${path}: IBIS asset bytes differ from modeling.ibisModelAssetSha256`)
    loaded.push(source)
  }
  const components=new Map(circuitJson.filter(e=>e.type==='source_component').map(e=>[e.source_component_id,e]))
  const compiled=declarations.plans.map(plan=>plan.models.map(model=>{
    const index=declarations.models.findIndex(selected=>selected.pipelineId===model.pipelineId)
    const input=modelRunDefinition(model,plan),source=loaded[index]
    input.definition.source={file:source.evidence.ibsFile,sha256:source.evidence.sourceSha256}
    let result: ReturnType<typeof converter.convertIbisModelToSpice>
    try {
      result=converter.convertIbisModelToSpice(source.bytes,input.definition,input.run)
    } catch (error) {
      if(error instanceof Error&&'code' in error&&error.code==='missing_run_state') {
        const entry=Object.entries(model.ibis_pin_name_to_source_port_id).find(([,portId])=>error.message.startsWith(`${portId}: `))
        if(entry) {
          const [ibisPin,portId]=entry,port=declarations.ports.get(portId),component=components.get(model.source_component_id)
          const ibisSignal=converter.parseIbis(source.text).components[model.ibis_component_name]?.pins[ibisPin]?.signal
          const componentName=component?.name??model.source_component_id
          const pinName=ibisSignal&&port?.name===ibisSignal&&ibisPin!==ibisSignal&&port.port_hints?.includes(ibisPin)?ibisPin:port?.name??portId
          const ibisLabel=ibisSignal&&ibisSignal!==ibisPin?(ibisPin===pinName?ibisSignal:ibisSignal===pinName?ibisPin:`${ibisPin} ${ibisSignal}`):ibisPin
          const detail=error.message.slice(portId.length+2)
          throw new converter.IbisError('missing_run_state',`${componentName}.${pinName} (IBIS ${ibisLabel}): ${detail} (${portId}); set ibisPinStates (e.g. { isOutput: false })`)
        }
      }
      throw error
    }
    return {...result,name:model.ibis_component_name,pipelineId:model.pipelineId,input,sourceEvidence:loaded[index].evidence}
  }))
  for(const [i,plan] of declarations.plans.entries()) validateProbeScope(plan,geometry,compiled[i],declarations.nodes,electrical)
  const files: FileMap=Object.create(null)
  for(const source of loaded) files[source.evidence.ibsFile]=source.text
  jsonFile(files,'inputs/modeling.json',modeling)
  jsonFile(files,'inputs/circuit.json',circuitJson)
  jsonFile(files,'geometry.json',geometry)
  jsonFile(files,'electrical-node-map.json',{nodes:declarations.nodes.mapping,channelReferenceSourcePortId:declarations.nodes.groundSourcePortId,scope:electrical.scope})
  jsonFile(files,'vendor-sources.json',loaded.map(source=>source.evidence))
  const extracted=await extractChannel(geometry,modeling,files,runSolver,onProgress)
  files['channel.cir']=channelSpice(extracted,modeling.sections)
  const pcbExperimentIds=new Set(declarations.plans.map(plan=>plan.simulationExperimentId))
  const results: CircuitJson=circuitJson.filter(record=>record.type!=='simulation_transient_voltage_graph'||!pcbExperimentIds.has(record.simulation_experiment_id)),experiments=[]
  for(const [index,plan] of declarations.plans.entries()) {
    const relative=`experiments/${plan.simulationExperimentId}`,dir=relative
    const solverFiles: FileMap=Object.create(null)
    const models=compiled[index],assembly=[]
    for(const model of models) {
      solverFiles[`${safeId(model.pipelineId)}.lib`]=model.source
      assembly.push({simulationIbisModelId:model.pipelineId,definition:model.input.definition,run:model.input.run,spicePinMapping:model.spicePinMapping,sourceSha256:model.sourceSha256,spiceSha256:sha256(model.source),sourceEvidence:model.sourceEvidence,metadata:model.metadata,warnings:model.warnings})
    }
    jsonFile(files,dir+'/native-ibis-assembly.json',assembly)
    jsonFile(files,dir+'/experiment.json',plan)
    solverFiles['simulation.cir']=generalSimulationSpice(plan,geometry,modeling,extracted,models,declarations.nodes,electrical)
    onProgress(`Simulate ${plan.name} (${plan.probes.length} probes, ${plan.eyes.length} eyes)`)
    const solve=await executeSolver(runSolver,files,dir,{solver:'ngspice',files:solverFiles,args:['-n','-b','simulation.cir'],outputFiles:['waveform.dat']})
    // ngspice can recover a singular operating point through gmin/source stepping.
    // Accept those warnings only when a complete finite transient follows.
    const diagnostic=(solve.stdout+'\n'+solve.stderr).split(/\r?\n/).find(line=>/\b(?:error|fatal|aborted|timestep too small)\b/i.test(line))
    if(diagnostic) fail('native_solver',`${plan.name}: ${diagnostic.trim()}`)
    const waveformText=solve.files['waveform.dat']
    const rows: number[][]=probeWaveformRows(waveformText,plan.probes)
    if(rows[0][0]>plan.startTimeSeconds+Math.max(plan.maxStepSeconds,plan.durationSeconds*1e-8)) fail('simulation_start',`${plan.name}: solver output omits the beginning of the declared recording`)
    if(Math.abs(rows[rows.length-1][0]-plan.durationSeconds)>plan.durationSeconds*1e-8) fail('simulation_duration',`${plan.name}: native solver did not complete the declared duration`)
    files[dir+'/waveform.csv']='time_s,'+plan.probes.map(probe=>probe.simulationVoltageProbeId+'_v').join(',')+'\n'+rows.map(row=>row.join(',')).join('\n')+'\n'
    jsonFile(files,dir+'/waveform.json',{simulationExperimentId:plan.simulationExperimentId,probes:plan.probes,samples:rows.length,timestamps:'actual adaptive solver times in seconds',source:'waveform.dat',sourceSha256:sha256(waveformText)})
    const eyes=[]
    for(const eye of plan.eyes) {
      const assessment=ddrAssessments.find(a=>a.eye===eye),ddrAssessment=assessment?assessDdr(rows,assessment):undefined
      const alignment=ddrAssessment?'received-differential-dqs':'stimulus-clock'
      const relativeEye=`eyes/${eye.simulationEyeDiagramId}`,eyeDir=dir+'/'+relativeEye,folded=foldProbeEye(rows,
        ddrAssessment?{...eye,captureTimesSeconds:ddrAssessment.captureTimesSeconds}:eye)
      files[eyeDir+'/eye-data.csv']='window,folded_time_s,time_s,voltage_v\n'+folded.samples.map((row: number[])=>row.join(',')).join('\n')+'\n'
      const descriptor={...eye,samples:folded.samples as number[][],alignment,ddrAssessment,directory:relativeEye,windows:folded.windows,pointsPerWindow:folded.pointsPerWindow,windowOriginsSeconds:folded.windowOriginsSeconds,boundaryIndices:folded.boundaryIndices,interpolation:'linear interpolation of actual adaptive solver timestamps',windowDefinition:ddrAssessment?'[received DQS crossing + sampleOffset - UI, received DQS crossing + sampleOffset + UI]; capture at center; complete windows only':'b_k=timeOrigin+k*UI; [b_k-UI/2,b_k+3*UI/2]; complete windows only',source:'../../waveform.csv',sourceSha256:sha256(files[dir+'/waveform.csv']),metrics:folded.metrics}
      jsonFile(files,eyeDir+'/eye-data.json',descriptor);eyes.push(descriptor)
    }
    jsonFile(files,dir+'/eyes.json',eyes)
    for(const probe of plan.probes) results.push(parseRecord({type:'simulation_transient_voltage_graph',simulation_transient_voltage_graph_id:`simulation_transient_voltage_graph_${plan.simulationExperimentId}_${probe.column}`,simulation_experiment_id:plan.simulationExperimentId,simulation_voltage_probe_id:probe.simulationVoltageProbeId,timestamps_ms:rows.map(row=>row[0]*1000),voltage_levels:rows.map(row=>row[probe.column]),time_per_step:plan.maxStepSeconds*1000,start_time_ms:rows[0][0]*1000,end_time_ms:rows[rows.length-1][0]*1000,name:probe.name}))
    experiments.push({plan,waveform:{timeUnit:'s' as const,voltageUnit:'V' as const,rows},simulationExperimentId:plan.simulationExperimentId,name:plan.name,directory:relative,durationSeconds:plan.durationSeconds,startTimeSeconds:plan.startTimeSeconds,maxStepSeconds:plan.maxStepSeconds,probes:plan.probes,eyes,solverInvocations:1,waveformSamples:rows.length,assembly,assemblyFile:relative+'/native-ibis-assembly.json'})
  }
  for(const graph of results.filter(record=>record.type==='simulation_transient_voltage_graph')) if(pcbExperimentIds.has(graph.simulation_experiment_id)&&!graph.simulation_voltage_probe_id) fail('result_schema','Installed Circuit JSON schema discarded the result probe ID')
  jsonFile(files,'circuit-results.json',results)
  const limitations=[...geometry.approximations,...compiled.flatMap(models=>models.flatMap(model=>model.warnings??[])),
    'Only selected channel components/passives and explicit ideal source rails are simulated; unrelated board electronics excluded',
    'Finite observed transient eyes; no implicit traffic, random jitter, BER extrapolation, protocol compliance or hardware accuracy claim',
    'Maximum solver integration step and display resolution are separate settings']
  return {circuitJson,simulationResultCircuitJson:results,modeling,geometry,matrices:extracted,experiments,limitations,files}
}
export type PipelineResult = Awaited<ReturnType<typeof runPipeline>>
