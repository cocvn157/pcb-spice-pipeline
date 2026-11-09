// Lane resolution + both reductions -> today's Geometry (was geometry.ts minus decks).
import type { ArtifactScope, Produced } from '../../kernel'
import type { CircuitJson } from '../schema'
import type { Board } from '../model'
import { fail } from '../diagnostics'
import { stackupFromCircuitJson, defaultCopperConductivitySm } from '../stackup'
import { selectPort, resolveRouteVias } from './ports'
import { routedCopperGeometry } from './routed'
import { groundPourLayers, measuredLaneSpacingMm, stackupStageReturn } from './returns'
import type { BoardModeling as Modeling, Geometry, GeometryCell, LaneGroup, LaneMapping, ResolvedModeling, RouteStage, RoutedPoint } from './types'

/** Returns `v` when it is a positive finite number; otherwise fails 'modeling_input' naming `label`. */
const positive=(v: unknown,label: string): number=>{
  if(typeof v!=='number'||!Number.isFinite(v)||v<=0) fail('modeling_input',`${label} must be a positive number`)
  return v
}
/** Returns `v` when it is a finite number; otherwise fails 'modeling_input' naming `label`. */
const finite=(v: unknown,label: string): number=>{
  if(typeof v!=='number'||!Number.isFinite(v)) fail('modeling_input',`${label} must be explicit and finite`)
  return v
}
/** Checks every modeling field the reductions rely on before any geometry is built, failing with the matching board code. */
export function validateModeling(m: Modeling): void {
  if(!['straightened-stages','routed-copper'].includes(m.reduction)) fail('reduction','Select straightened-stages or routed-copper')
  if(!Array.isArray(m.lanes)||![1,2,3].includes(m.lanes.length)) fail('lanes','One to three explicit source/receiver lanes are supported')
  for(const [i,l] of m.lanes.entries()) if(!l.port||!l.from||!l.to) fail('pin_mapping',`Lane ${i}: port/from/to mappings required`)
  if(new Set(m.lanes.map(l=>l.port)).size!==m.lanes.length) fail('pin_mapping','Lane port labels must be distinct')
  if(m.reduction==='routed-copper') {
    positive(m.relativePermittivity,'relativePermittivity (homogeneous dielectric approximation)')
    positive(m.extraction?.groundMeshMm,'extraction.groundMeshMm')
  }
  for(const [name,p] of Object.entries(m.reduction==='routed-copper'?{}:m.profiles??{})) {
    positive(p.spacingMm,`${name} spacingMm`)
    positive(p.relativePermittivity,`${name} relativePermittivity`)
    if(!p.return) fail('return_geometry',`${name}: explicit finite return required`)
    for(const key of ['widthMm','thicknessMm','lengthFactor'] as const) positive(p.return[key],`${name}.return.${key}`)
    finite(p.return.centerYMm,`${name}.return.centerYMm`)
    finite(p.return.centerZMm,`${name}.return.centerZMm`)
  }
  if(!m.extraction) fail('extraction','Explicit mesh/frequency/model settings required')
  for(const key of ['minimumHz','maximumHz','modelHz','filaments','refinementFilaments','convergenceTolerance','capTolerance','maxPanelLengthMm','reciprocityTolerance','dcResistanceTolerance'] as const) positive(m.extraction[key],`extraction.${key}`)
  if(m.extraction.minimumHz>m.extraction.modelHz||m.extraction.modelHz>m.extraction.maximumHz||!Number.isInteger(m.extraction.filaments)) fail('extraction','Require minimumHz <= modelHz <= maximumHz and integer filaments')
  if(!Number.isInteger(m.extraction.refinementFilaments)||m.extraction.refinementFilaments<=m.extraction.filaments) fail('extraction','Integer refinementFilaments must exceed filaments')
  if(!Number.isInteger(m.sections)||m.sections<1||m.sections>128) fail('sections','sections must be an integer 1..128')
}
/** Resolves each lane to its routed PCB trace and reduces the routes to geometry cells (straightened stages) or routed copper. */
export function geometryFromCircuitJson(cj: CircuitJson,modeling: Modeling): Geometry {
  if(!Array.isArray(cj)) fail('circuit_json','Expected a Circuit JSON element array, not a mesh-preparation object')
  const stackup = stackupFromCircuitJson(cj)
  for (const key of ['stackup', 'conductivitySm', 'copperLayers']) if (key in modeling)
    fail('modeling_input', `Remove modeling.${key}; physical construction comes from Circuit JSON pcb_stackup`)
  const m: ResolvedModeling = {...modeling, stackup: stackup.copperLayers, conductivitySm: defaultCopperConductivitySm,
    relativePermittivity: modeling.relativePermittivity ?? stackup.relativePermittivity, viaPlatingMm: modeling.viaPlatingMm ?? stackup.viaPlatingMm}
  validateModeling(m)
  const routes: RouteStage[][]=[]
  const mappings: LaneMapping[]=[]
  const selectedTraces=new Set<string>()
  const selectedPorts=new Set<string>()
  for(const lane of m.lanes) {
    const from=selectPort(cj,lane.from)
    const to=selectPort(cj,lane.to)
    if(from.source_port_id===to.source_port_id||[from.source_port_id,to.source_port_id].some(id=>selectedPorts.has(id))) fail('pin_mapping',`${lane.port}: selected lanes require distinct physical source and receiver ports`)
    selectedPorts.add(from.source_port_id)
    selectedPorts.add(to.source_port_id)
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
      finite(p.x,`${lane.port} route[${i}].x`)
      finite(p.y,`${lane.port} route[${i}].y`)
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
    for(const p of ports) {
      finite(p.x,`${p.pcb_port_id}.x`)
      finite(p.y,`${p.pcb_port_id}.y`)
    }
    /** True when a route point sits on a port position (within 1e-5 mm). */
    const matches=(a: { x: number; y: number },p: { x: number; y: number }): boolean=>Math.hypot(a.x-p.x,a.y-p.y)<1e-5
    if(matches(route[0],ports[1])&&matches(route[route.length-1],ports[0])) route=[...route].reverse().map(p=>p.route_type==='via'?{...p,from_layer:p.to_layer,to_layer:p.from_layer}:p)
    if(!matches(route[0],ports[0])||!matches(route[route.length-1],ports[1])) fail('endpoint_position',`${lane.port}: routed endpoints do not match selected physical source/receiver ports`)
    for(const [point,port] of [[route[0],ports[0]],[route[route.length-1],ports[1]]] as const) {
      if(point.route_type==='wire'&&!port.layers.includes(point.layer)) fail('endpoint_layer',`${lane.port}: route layer does not reach physical pad ${port.pcb_port_id}`)
      for(const key of ['start_pcb_port_id','end_pcb_port_id'] as const) if(point.route_type==='wire'&&point[key]&&point[key]!==port.pcb_port_id) fail('stale_endpoint',`${lane.port}: ${key}=${point[key]} disagrees with ${port.pcb_port_id}; repair source metadata explicitly`)
    }
    const stages: RouteStage[]=[]
    /** Looks up the stackup copper layer named `n`, failing 'stackup' when it is missing. */
    const layer=(n: string): ResolvedModeling['stackup'][number]=>{
      const l=m.stackup.find(l=>l.name===n)
      if(!l) fail('stackup',`No copper z range for ${n}`)
      return l
    }
    for(let i=1;i<route.length;i++) {
      const a=route[i-1]
      const b=route[i]
      if(!['wire','via'].includes(a.route_type)||!['wire','via'].includes(b.route_type)) fail('route_type','Only wire/via routed primitives supported')
      const distance=Math.hypot(b.x-a.x,b.y-a.y)
      if(b.route_type==='via') {
        if(distance>1e-5) fail('via_geometry','Via must follow a co-located wire vertex')
        if(a.route_type!=='wire'||a.layer!==b.from_layer||b.from_layer===b.to_layer) fail('via_geometry','Via must continue preceding wire layer and change layer')
        const la=layer(b.from_layer)
        const lb=layer(b.to_layer)
        const plating=positive(m.viaPlatingMm,'viaPlatingMm (not recorded in ordinary Circuit JSON)')
        const width=positive(m.viaEquivalentWidthMm,'viaEquivalentWidthMm')
        if(!m.omitThroughViaStubs) fail('via_stub','This reduction requires explicit omitThroughViaStubs=true')
        const hole=positive(b.hole_diameter,'hole_diameter')
        const area=Math.PI*((hole/2+plating)**2-(hole/2)**2)
        const length=Math.abs((la.zMinMm+la.zMaxMm-lb.zMinMm-lb.zMaxMm)/2)
        positive(length,'via active length')
        stages.push({kind:'via',profile:'via',lengthMm:length,widthMm:width,thicknessMm:area/width,holeMm:hole,platingMm:plating})
      } else if(distance>1e-10) {
        const layerName=a.route_type==='via'?a.to_layer:a.layer
        if(b.layer!==layerName) fail('layer_transition','Layer change requires explicit via')
        const l=layer(layerName)
        const width=positive(b.width,'route wire width')
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
  const laneGroups: LaneGroup[]=[]
  routes.forEach((route,laneIndex)=>{
    const stages=route.map(s=>s.profile)
    const key=stages.join('\0')
    const found=laneGroups.find(group=>group.stages.join('\0')===key)
    if(found) {
      found.lanes.push(mappings[laneIndex].port)
      found.laneIndices.push(laneIndex)
    } else {
      laneGroups.push({lanes:[mappings[laneIndex].port],laneIndices:[laneIndex],stages})
    }
  })
  let grounds: Set<string>|undefined
  /** Ground-pour layers for derived returns, computed once on first use. */
  const groundLayers=(): Set<string>=>grounds??=groundPourLayers(cj,m.channelReference?selectPort(cj,m.channelReference).source_port_id:undefined)
  const cells: GeometryCell[]=[]
  for(const group of laneGroups) {
    group.stages.forEach((name,stageIndex)=>{
      const i=cells.length
      const signals=group.laneIndices.map(laneIndex=>routes[laneIndex][stageIndex])
      const profile=m.profiles?.[name]
      // Without a declared profile, a wire stage returns in the adjacent ground
      // planes from pcb_stackup; via stages still need an explicit `via` profile.
      if(!profile&&signals[0].kind!=='wire') fail('return_geometry',`Missing ${name} return/material profile; via stages need an explicit straightened-stage profile`)
      const derived=profile?undefined:stackupStageReturn(stackup,groundLayers(),name)
      const spacingMm=profile?profile.spacingMm:signals.length>1?measuredLaneSpacingMm(group.laneIndices.map(laneIndex=>mappings[laneIndex].originalRoute),name):0
      const length=Math.max(...signals.map(s=>s.lengthMm))/1000
      const conductors: GeometryCell['conductors']=signals.map((s,j)=>({name:`sig${j}`,lengthM:s.lengthMm/1000,widthM:s.widthMm/1000,thicknessM:s.thicknessMm/1000,conductivitySm:s.conductivitySm??defaultCopperConductivitySm,yM:(j-(signals.length-1)/2)*spacingMm/1000,zM:0}))
      const parts=profile?[{widthM:profile.return.widthMm/1000,thicknessM:profile.return.thicknessMm/1000,yM:profile.return.centerYMm/1000,zM:profile.return.centerZMm/1000}]
        :derived!.parts.map(p=>({widthM:p.widthMm/1000,thicknessM:p.thicknessMm/1000,yM:0,zM:p.centerZMm/1000}))
      conductors.push({name:'return',lengthM:length*(profile?.return.lengthFactor??1),...parts[0],conductivitySm:defaultCopperConductivitySm,...(parts.length>1?{parts}:{})})
      const boxes=conductors.flatMap(c=>(c.parts??[c]).map(p=>({name:c.name,...p})))
      for(let a=0;a<boxes.length;a++) for(let b=a+1;b<boxes.length;b++) if(Math.abs(boxes[a].yM-boxes[b].yM)<(boxes[a].widthM+boxes[b].widthM)/2 && Math.abs(boxes[a].zM-boxes[b].zM)<(boxes[a].thicknessM+boxes[b].thicknessM)/2) fail('conductor_overlap',`Stage ${i}: ${boxes[a].name}/${boxes[b].name} overlap`)
      cells.push({stage:i,profile:name,conductors,relativePermittivity:profile?profile.relativePermittivity:derived!.relativePermittivity,conductivitySm:m.conductivitySm,...(laneGroups.length>1?{lanes:group.lanes,laneIndices:group.laneIndices}:{})})
    })
  }
  const approximations=['Actual stage lengths, widths and ordered layer transitions from routed Circuit JSON; routes straightened within each stage','Uniform signal center spacing per stage (declared, or the median routed spacing between lanes); actual varying route spacing is not extracted','Finite parallel return bar per stage (declared profile, or one 2 mm bar in each adjacent ground-pour layer from pcb_stackup); isolated neutral conductor group, with ideal reference joins between stages','Homogeneous explicit effective permittivity per stage; no dielectric loss, roughness, plane cutouts, unselected neighboring nets or bend coupling','Via rectangle preserves assumed plated barrel metal area; pads and unconnected through-via stubs omitted','Whole-stage matrices divided into uniform pi sections; constant R/L at modelHz; frequency dispersion not fitted']
  if(laneGroups.length>1) approximations.push(`Lanes grouped by ordered layer/via stage topology (${laneGroups.map(g=>`${g.lanes.join(', ')} on ${g.stages.join(' -> ')}`).join('; ')}); electromagnetic coupling between distinct stage-topology groups is omitted`)
  return {stackup,cells,mappings,...(laneGroups.length>1?{laneGroups}:{}),units:{circuitJson:'mm',geometry:'m',conductivity:'S/m'},approximations}
}

/** Board + board modeling -> today's Geometry, plus `geometry.json` under `scope` (byte-identical to jsonFile). */
export function channelGeometry(board: Board, modeling: Modeling, scope: ArtifactScope): Produced<Geometry> {
  const value = geometryFromCircuitJson(board.circuitJson, modeling)
  return { value, artifacts: [scope.json('geometry.json', value)] }
}
