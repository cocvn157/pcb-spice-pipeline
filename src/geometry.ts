import { stackupFromCircuitJson, defaultCopperConductivitySm, type BoardStackup, type CopperLayer } from './stackup.js'
import type { CircuitJson } from './schema.js'
import { fail } from './matrices.mjs'
import { routedCopperGeometry, copperFastHenryDeck, copperFasterCapDeck } from './copper.js'
import type { RoutedCopper } from './copper.js'
import type { DdrAssessmentConfig } from './ddr.js'

export type PortSelector = { sourcePortId: string; component?: never; port?: never } | { sourcePortId?: never; component: string; port: string }
export interface ExtractionSettings {
  minimumHz: number; maximumHz: number; modelHz: number
  filaments: number; refinementFilaments: number; convergenceTolerance: number
  capTolerance: number; maxPanelLengthMm: number; reciprocityTolerance: number; dcResistanceTolerance: number
  groundMeshMm?: number
}
export interface ReturnBarProfile {
  widthMm: number; thicknessMm: number; lengthFactor: number; centerYMm: number; centerZMm: number
}
export interface Modeling {
  ddrAssessments?: DdrAssessmentConfig[]
  reduction: 'straightened-stages' | 'routed-copper'; sections: number
  relativePermittivity?: number
  groundReturn?: PortSelector
  lanes: { port: string; from: PortSelector; to: PortSelector; sourceTraceId?: string; driverPort?: string; receiverPort?: string }[]
  profiles?: Record<string, { spacingMm: number; relativePermittivity: number; return: ReturnBarProfile | ReturnBarProfile[] }>
  extraction: ExtractionSettings
  viaPlatingMm?: number; viaEquivalentWidthMm?: number; omitThroughViaStubs?: boolean
  channelReference?: PortSelector
  supplies?: { positive: PortSelector; negative: PortSelector; voltageV: number }[]
  passiveComponents?: { sourceComponentId?: string; component?: string }[]
  description?: string
}
export interface ResolvedModeling extends Modeling {
  conductivitySm: number
  stackup: CopperLayer[]
}
export interface RouteStage {
  kind: 'wire' | 'via'; profile: string; lengthMm: number; widthMm: number; thicknessMm: number
  conductivitySm?: number
  holeMm?: number; platingMm?: number
}
type SourcePort = Extract<CircuitJson[number], { type: 'source_port' }>
type RoutePoint = Extract<CircuitJson[number], { type: 'pcb_trace' }>['route'][number]
type RoutedPoint = Exclude<RoutePoint, { route_type: 'through_pad' }>

/** Native pcbPath keeps via dimensions on the associated physical record. */
export function resolveRouteVias(circuit: CircuitJson, trace: Extract<CircuitJson[number], {type:'pcb_trace'}>): RoutedPoint[] {
  return trace.route.map(point => {
    if(point.route_type==='through_pad') fail('route_type','Only wire/via routed primitives supported')
    if(point.route_type!=='via') return point
    const matches=circuit.filter(e=>e.type==='pcb_via').filter(via=>
      (via.pcb_trace_id===trace.pcb_trace_id||(via.source_trace_id!==undefined&&via.source_trace_id===trace.source_trace_id))&&
      (via.pcb_trace_id===undefined||via.pcb_trace_id===trace.pcb_trace_id)&&
      (via.source_trace_id===undefined||via.source_trace_id===trace.source_trace_id)&&
      via.subcircuit_id===trace.subcircuit_id&&
      Math.hypot(via.x-point.x,via.y-point.y)<1e-5)
    if(matches.length>1) fail('via_geometry',`${trace.pcb_trace_id}: ambiguous native via at ${point.x},${point.y}`)
    if(matches[0]&&(!matches[0].layers.includes(point.from_layer)||!matches[0].layers.includes(point.to_layer)))
      fail('via_geometry',`${trace.pcb_trace_id}: physical via layers disagree at ${point.x},${point.y}`)
    const holes=[point.hole_diameter,matches[0]?.hole_diameter].filter((v): v is number=>v!==undefined)
    if(!holes.length||holes.some(v=>!Number.isFinite(v)||v<=0||v!==holes[0]))
      fail('via_geometry',`${trace.pcb_trace_id}: missing, invalid or conflicting via hole diameters at ${point.x},${point.y}`)
    return {...point,hole_diameter:holes[0]}
  })
}
export interface LaneMapping {
  port: string; sourceTraceId: string; pcbTraceId: string; from: string; to: string
  pcbPorts: string[]; stages: RouteStage[]; originalRoute: RoutedPoint[]
}
export interface ConductorBar {
  lengthM: number; widthM: number; thicknessM: number; yM: number; zM: number; conductivitySm?: number
}
export interface GeometryCell {
  stage: number; profile: string; relativePermittivity: number; conductivitySm: number
  conductors: (ConductorBar & { name: string; bars?: ConductorBar[] })[]
  routedCopper?: RoutedCopper
}
export interface Geometry {
  stackup?: BoardStackup
  cells: GeometryCell[]; mappings: LaneMapping[]
  units: { circuitJson: 'mm'; geometry: 'm'; conductivity: 'S/m' }; approximations: string[]
}

const positive=(v: unknown,label: string): number=>{if(typeof v!=='number'||!Number.isFinite(v)||v<=0) fail('modeling_input',`${label} must be a positive number`);return v}
const finite=(v: unknown,label: string): number=>{if(typeof v!=='number'||!Number.isFinite(v)) fail('modeling_input',`${label} must be explicit and finite`);return v}
export function validateModeling(m: Modeling): void {
  if(!['straightened-stages','routed-copper'].includes(m.reduction)) fail('reduction','Select straightened-stages or routed-copper')
  if(!Array.isArray(m.lanes)||![1,2,3].includes(m.lanes.length)) fail('lanes','One to three explicit source/receiver lanes are supported')
  for(const [i,l] of m.lanes.entries()) if(!l.port||!l.from||!l.to) fail('pin_mapping',`Lane ${i}: port/from/to mappings required`)
  if(new Set(m.lanes.map(l=>l.port)).size!==m.lanes.length) fail('pin_mapping','Lane port labels must be distinct')
  if(m.reduction==='routed-copper') {
    positive(m.relativePermittivity,'relativePermittivity (homogeneous dielectric approximation)')
    positive(m.extraction?.groundMeshMm,'extraction.groundMeshMm')
  }
  else if(!m.profiles) fail('return_geometry','Explicit profiles with reference conductor geometry and permittivity required')
  for(const [name,p] of Object.entries(m.reduction==='routed-copper'?{}:m.profiles!)) {
    positive(p.spacingMm,`${name} spacingMm`);positive(p.relativePermittivity,`${name} relativePermittivity`)
    const bars=Array.isArray(p.return)?p.return:p.return?[p.return]:[]
    if(!bars.length) fail('return_geometry',`${name}: explicit finite return required`)
    bars.forEach((bar,i)=>{
      const prefix=Array.isArray(p.return)?`${name}.return[${i}]`:`${name}.return`
      if(!bar) fail('return_geometry',`${prefix}: explicit finite return required`)
      for(const key of ['widthMm','thicknessMm','lengthFactor'] as const) positive(bar[key],`${prefix}.${key}`)
      finite(bar.centerYMm,`${prefix}.centerYMm`);finite(bar.centerZMm,`${prefix}.centerZMm`)
    })
  }
  if(!m.extraction) fail('extraction','Explicit mesh/frequency/model settings required')
  for(const key of ['minimumHz','maximumHz','modelHz','filaments','refinementFilaments','convergenceTolerance','capTolerance','maxPanelLengthMm','reciprocityTolerance','dcResistanceTolerance'] as const) positive(m.extraction[key],`extraction.${key}`)
  if(m.extraction.minimumHz>m.extraction.modelHz||m.extraction.modelHz>m.extraction.maximumHz||!Number.isInteger(m.extraction.filaments)) fail('extraction','Require minimumHz <= modelHz <= maximumHz and integer filaments')
  if(!Number.isInteger(m.extraction.refinementFilaments)||m.extraction.refinementFilaments<=m.extraction.filaments) fail('extraction','Integer refinementFilaments must exceed filaments')
  if(!Number.isInteger(m.sections)||m.sections<1||m.sections>128) fail('sections','sections must be an integer 1..128')
}
export function selectPort(cj: CircuitJson,s: PortSelector | undefined): SourcePort {
  if(!s) fail('pin_mapping','Explicit physical source port selector required')
  if(s.sourcePortId) {const ports=cj.filter((e): e is SourcePort=>e.type==='source_port'&&e.source_port_id===s.sourcePortId);if(ports.length!==1) fail('pin_mapping',`${s.sourcePortId}: expected one source port, got ${ports.length}`);return ports[0]}
  const components=cj.filter(e=>e.type==='source_component').filter(e=>e.name===s.component)
  if(components.length!==1) fail('pin_mapping',`${s.component}: expected one source component, got ${components.length}; use sourcePortId in repeated scopes`)
  const component=components[0]
  const ports=cj.filter(e=>e.type==='source_port').filter(e=>e.source_component_id===component.source_component_id && (e.port_hints?.includes(s.port??'')||e.name===s.port||`pin${e.pin_number}`===s.port))
  if(ports.length!==1) fail('pin_mapping',`${s.component}.${s.port}: expected one source port, got ${ports.length}`)
  return ports[0]
}
export function geometryFromCircuitJson(cj: CircuitJson,modeling: Modeling): Geometry {
  if(!Array.isArray(cj)) fail('circuit_json','Expected a Circuit JSON element array, not a mesh-preparation object')
  const stackup = stackupFromCircuitJson(cj)
  for (const key of ['stackup', 'conductivitySm', 'copperLayers']) if (key in modeling)
    fail('modeling_input', `Remove modeling.${key}; physical construction comes from Circuit JSON pcb_stackup`)
  const m: ResolvedModeling = {...modeling, stackup: stackup.copperLayers, conductivitySm: defaultCopperConductivitySm,
    relativePermittivity: modeling.relativePermittivity ?? stackup.relativePermittivity, viaPlatingMm: modeling.viaPlatingMm ?? stackup.viaPlatingMm}
  validateModeling(m)
  const routes: RouteStage[][]=[],mappings: LaneMapping[]=[]
  const selectedTraces=new Set<string>(),selectedPorts=new Set<string>()
  for(const lane of m.lanes) {
    const from=selectPort(cj,lane.from),to=selectPort(cj,lane.to)
    if(from.source_port_id===to.source_port_id||[from.source_port_id,to.source_port_id].some(id=>selectedPorts.has(id))) fail('pin_mapping',`${lane.port}: selected lanes require distinct physical source and receiver ports`)
    selectedPorts.add(from.source_port_id);selectedPorts.add(to.source_port_id)
    const sources=cj.filter(e=>e.type==='source_trace').filter(e=>(lane.sourceTraceId?e.source_trace_id===lane.sourceTraceId:e.connected_source_port_ids?.includes(from.source_port_id)&&e.connected_source_port_ids?.includes(to.source_port_id)))
    if(sources.length!==1) fail('route_selection',`${lane.port}: expected one source trace; specify sourceTraceId`)
    const src=sources[0]
    if(!src.connected_source_port_ids?.includes(from.source_port_id)||!src.connected_source_port_ids?.includes(to.source_port_id)) fail('pin_mapping',`${lane.port}: selected trace does not connect requested source ports`)
    if(src.connected_source_port_ids.length!==2) fail('route_selection',`${lane.port}: fan-out is unsupported; selected trace must connect exactly the two requested ports`)
    if(selectedTraces.has(src.source_trace_id)) fail('route_selection',`${lane.port}: selected lanes must use distinct source traces`)
    selectedTraces.add(src.source_trace_id)
    const traces=cj.filter(e=>e.type==='pcb_trace').filter(e=>e.source_trace_id===src.source_trace_id)
    if(traces.length!==1) fail('route_selection',`${lane.port}: expected one complete PCB route, got ${traces.length}`)
    const original=resolveRouteVias(cj,traces[0])
    if(!Array.isArray(original)||original.length<2) fail('empty_route',`${lane.port}: at least two routed vertices required`)
    let route: RoutedPoint[]=original.map((p,i)=>{
      if(p.route_type!=='wire'&&p.route_type!=='via') fail('route_type','Only wire/via routed primitives supported')
      finite(p.x,`${lane.port} route[${i}].x`);finite(p.y,`${lane.port} route[${i}].y`)
      if(p.route_type==='wire') {
        positive(p.width,`${lane.port} route[${i}].width`)
        if(p.start_width!==undefined||p.end_width!==undefined||p.width_interpolation_mode!==undefined) fail('varying_width','Tapered routes are not supported by the straightened-stage reduction')
      }
      return p
    })
    if(route[0].route_type!=='wire'||route[route.length-1].route_type!=='wire') fail('route_type','Routed endpoints must be wire vertices at the selected PCB ports')
    const ports=[from,to].map(p=>{
      const matches=cj.filter(e=>e.type==='pcb_port').filter(e=>e.source_port_id===p.source_port_id)
      if(matches.length!==1) fail('pin_mapping',`${lane.port}: expected one PCB port for ${p.source_port_id}, got ${matches.length}`)
      return matches[0]
    })
    for(const p of ports) {finite(p.x,`${p.pcb_port_id}.x`);finite(p.y,`${p.pcb_port_id}.y`)}
    const matches=(a: { x: number; y: number },p: { x: number; y: number })=>Math.hypot(a.x-p.x,a.y-p.y)<1e-5
    if(matches(route[0],ports[1])&&matches(route[route.length-1],ports[0])) route=[...route].reverse().map(p=>p.route_type==='via'?{...p,from_layer:p.to_layer,to_layer:p.from_layer}:p)
    if(!matches(route[0],ports[0])||!matches(route[route.length-1],ports[1])) fail('endpoint_position',`${lane.port}: routed endpoints do not match selected physical source/receiver ports`)
    for(const [point,port] of [[route[0],ports[0]],[route[route.length-1],ports[1]]] as const) {
      if(point.route_type==='wire'&&!port.layers.includes(point.layer)) fail('endpoint_layer',`${lane.port}: route layer does not reach physical pad ${port.pcb_port_id}`)
      for(const key of ['start_pcb_port_id','end_pcb_port_id'] as const) if(point.route_type==='wire'&&point[key]&&point[key]!==port.pcb_port_id) fail('stale_endpoint',`${lane.port}: ${key}=${point[key]} disagrees with ${port.pcb_port_id}; repair source metadata explicitly`)
    }
    const stages: RouteStage[]=[]
    const layer=(n: string)=>{const l=m.stackup.find(l=>l.name===n);if(!l) fail('stackup',`No copper z range for ${n}`);return l}
    for(let i=1;i<route.length;i++) {
      const a=route[i-1],b=route[i]
      if(!['wire','via'].includes(a.route_type)||!['wire','via'].includes(b.route_type)) fail('route_type','Only wire/via routed primitives supported')
      const distance=Math.hypot(b.x-a.x,b.y-a.y)
      if(b.route_type==='via') {
        if(distance>1e-5) fail('via_geometry','Via must follow a co-located wire vertex')
        if(a.route_type!=='wire'||a.layer!==b.from_layer||b.from_layer===b.to_layer) fail('via_geometry','Via must continue preceding wire layer and change layer')
        const la=layer(b.from_layer),lb=layer(b.to_layer)
        const plating=positive(m.viaPlatingMm,'viaPlatingMm (not recorded in ordinary Circuit JSON)'),width=positive(m.viaEquivalentWidthMm,'viaEquivalentWidthMm')
        if(!m.omitThroughViaStubs) fail('via_stub','This reduction requires explicit omitThroughViaStubs=true')
        const hole=positive(b.hole_diameter,'hole_diameter')
        const area=Math.PI*((hole/2+plating)**2-(hole/2)**2)
        const length=Math.abs((la.zMinMm+la.zMaxMm-lb.zMinMm-lb.zMaxMm)/2)
        positive(length,'via active length')
        stages.push({kind:'via',profile:'via',lengthMm:length,widthMm:width,thicknessMm:area/width,holeMm:hole,platingMm:plating})
      } else if(distance>1e-10) {
        const layerName=a.route_type==='via'?a.to_layer:a.layer
        if(b.layer!==layerName) fail('layer_transition','Layer change requires explicit via')
        const l=layer(layerName), width=positive(b.width,'route wire width')
        if(a.route_type==='wire'&&a.width!==b.width) fail('varying_width','Width transitions require explicit supported stage reduction')
        const last=stages.at(-1)
        if(last?.kind==='wire'&&last.profile===layerName&&last.widthMm===width) last.lengthMm+=distance
        else stages.push({kind:'wire',profile:layerName,lengthMm:distance,widthMm:width,thicknessMm:l.zMaxMm-l.zMinMm,conductivitySm:l.conductivitySm})
      } else if(b.layer!==(a.route_type==='via'?a.to_layer:a.layer)) {
        fail('layer_transition','Co-located layer change still requires explicit via')
      }
    }
    if(!stages.length) fail('empty_route',lane.port)
    routes.push(stages)
    mappings.push({port:lane.port,sourceTraceId:src.source_trace_id,pcbTraceId:traces[0].pcb_trace_id,from:from.source_port_id,to:to.source_port_id,pcbPorts:ports.map(p=>p.pcb_port_id),stages,originalRoute:route})
  }
  if(m.reduction==='routed-copper') return {...routedCopperGeometry(cj,m,mappings),stackup}
  if(routes.some(route=>route.length!==routes[0].length||route.some((s,i)=>s.profile!==routes[0][i].profile))) fail('route_topology','Selected routes must have identical ordered layer/via stage topology')
  const cells: GeometryCell[]=routes[0].map((_,i)=>{
    const signals=routes.map(r=>r[i]),profile=m.profiles![signals[0].profile]
    if(!profile) fail('return_geometry',`Missing ${signals[0].profile} return/material profile`)
    const conductors: GeometryCell['conductors']=signals.map((s,j)=>({name:`sig${j}`,lengthM:s.lengthMm/1000,widthM:s.widthMm/1000,thicknessM:s.thicknessMm/1000,conductivitySm:s.conductivitySm??defaultCopperConductivitySm,yM:(j-(signals.length-1)/2)*profile.spacingMm/1000,zM:0}))
    const maxSignalLengthM=Math.max(...signals.map(s=>s.lengthMm))/1000
    const returnBars=(Array.isArray(profile.return)?profile.return:[profile.return]).map(bar=>({
      lengthM:maxSignalLengthM*bar.lengthFactor,widthM:bar.widthMm/1000,thicknessM:bar.thicknessMm/1000,
      conductivitySm:defaultCopperConductivitySm,yM:bar.centerYMm/1000,zM:bar.centerZMm/1000,
    }))
    const firstReturn=returnBars[0]
    const parallelConductance=returnBars.reduce((sum,bar)=>sum+(bar.conductivitySm??defaultCopperConductivitySm)*bar.widthM*bar.thicknessM/bar.lengthM,0)
    const equivalentThicknessM=firstReturn.lengthM/((firstReturn.conductivitySm??defaultCopperConductivitySm)*firstReturn.widthM)*parallelConductance
    conductors.push({name:'return',...firstReturn,thicknessM:returnBars.length===1?firstReturn.thicknessM:equivalentThicknessM,...(returnBars.length>1?{bars:returnBars}:{})})
    const physicalBars=[...conductors.slice(0,-1),...returnBars.map((bar,j)=>({...bar,name:returnBars.length>1?`return[${j}]`:'return'}))]
    for(let a=0;a<physicalBars.length;a++) for(let b=a+1;b<physicalBars.length;b++) if(Math.abs(physicalBars[a].yM-physicalBars[b].yM)<(physicalBars[a].widthM+physicalBars[b].widthM)/2 && Math.abs(physicalBars[a].zM-physicalBars[b].zM)<(physicalBars[a].thicknessM+physicalBars[b].thicknessM)/2) fail('conductor_overlap',`Stage ${i}: ${physicalBars[a].name}/${physicalBars[b].name} overlap`)
    return {stage:i,profile:signals[0].profile,conductors,relativePermittivity:profile.relativePermittivity,conductivitySm:m.conductivitySm}
  })
  return {stackup,cells,mappings,units:{circuitJson:'mm',geometry:'m',conductivity:'S/m'},approximations:['Actual stage lengths, widths and ordered layer transitions from routed Circuit JSON; routes straightened within each stage','Uniform declared signal center spacing per profile; actual varying route spacing is not extracted','Finite parallel return bar per stage; isolated neutral conductor group, with ideal reference joins between stages','Homogeneous explicit effective permittivity per stage; no dielectric loss, roughness, plane cutouts, unselected neighboring nets or bend coupling','Via rectangle preserves assumed plated barrel metal area; pads and unconnected through-via stubs omitted','Whole-stage matrices divided into uniform pi sections; constant R/L at modelHz; frequency dispersion not fitted']}
}
export function fastHenryDeck(cell: GeometryCell,extraction: ExtractionSettings): string {
  if(cell.routedCopper) return copperFastHenryDeck(cell,extraction)
  const lines=[`* PCB pipeline: ${cell.conductors.length} primitive paths, all oriented +x`,'.units m',`.default sigma=${cell.conductivitySm} nhinc=${extraction.filaments} nwinc=${extraction.filaments}`]
  for(const [i,c] of cell.conductors.entries()) {
    const bars=c.bars??[c]
    bars.forEach((bar,j)=>{
      const na=j===0?`N${i}a`:`N${i}_${j}a`,nb=j===0?`N${i}b`:`N${i}_${j}b`,edge=j===0?`E${i}`:`E${i}_${j}`
      lines.push(`${na} x=0 y=${bar.yM} z=${bar.zM}`,`${nb} x=${bar.lengthM} y=${bar.yM} z=${bar.zM}`,`${edge} ${na} ${nb} w=${bar.widthM} h=${bar.thicknessM} sigma=${bar.conductivitySm??cell.conductivitySm} wx=0 wy=1 wz=0`)
      if(j>0) lines.push(`.equiv N${i}a ${na}`,`.equiv N${i}b ${nb}`)
    })
  }
  for(let i=0;i<cell.conductors.length;i++) lines.push(`.external N${i}a N${i}b`)
  lines.push(`.freq fmin=${extraction.minimumHz} fmax=${extraction.maximumHz} ndec=1`,'.end')
  return lines.join('\n')+'\n'
}
export function fasterCapDeck(cell: GeometryCell,extraction: ExtractionSettings): Record<string,string> {
  if(cell.routedCopper) return copperFasterCapDeck(cell,extraction)
  const files: Record<string,string>={},list=['* 3D conductor surfaces; metres; homogeneous dielectric']
  for(const c of cell.conductors) {
    const rows=['* closed box conductor surface'],bars=c.bars??[c]
    const quad=(vs: [number,number,number][])=>rows.push(`Q ${c.name} ${vs.flat().join(' ')}`)
    for(const bar of bars) {
      const n=Math.ceil(bar.lengthM/(extraction.maxPanelLengthMm/1000))
      const y0=bar.yM-bar.widthM/2,y1=bar.yM+bar.widthM/2,z0=bar.zM-bar.thicknessM/2,z1=bar.zM+bar.thicknessM/2
      for(let k=0;k<n;k++) {
        const a=bar.lengthM*k/n,b=bar.lengthM*(k+1)/n
        quad([[a,y0,z0],[b,y0,z0],[b,y1,z0],[a,y1,z0]])
        quad([[a,y1,z1],[b,y1,z1],[b,y0,z1],[a,y0,z1]])
        quad([[a,y0,z1],[b,y0,z1],[b,y0,z0],[a,y0,z0]])
        quad([[a,y1,z0],[b,y1,z0],[b,y1,z1],[a,y1,z1]])
      }
      quad([[0,y0,z0],[0,y1,z0],[0,y1,z1],[0,y0,z1]])
      quad([[bar.lengthM,y0,z1],[bar.lengthM,y1,z1],[bar.lengthM,y1,z0],[bar.lengthM,y0,z0]])
    }
    files[`${c.name}.txt`]=rows.join('\n')+'\n'
    list.push(`C ${c.name}.txt ${cell.relativePermittivity} 0 0 0`)
  }
  files['channel.lst']=list.join('\n')+'\n'
  return files
}
