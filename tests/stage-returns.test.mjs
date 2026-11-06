import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {geometryFromCircuitJson,fastHenryDeck,fasterCapDeck} from '../src/geometry.js'
import {stackupFromCircuitJson} from '../src/stackup.js'
import {stackupStageReturn} from '../src/stage-returns.js'
const readJson=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'))
const small={circuitJson:await readJson('./fixtures/straight.circuit.json'),modeling:await readJson('./fixtures/straight.modeling.json')}

// Small fixture plus a GND pour on `bottom` reached from the reference pin.
function withGroundPour(){
  const cj=structuredClone(small.circuitJson)
  cj.push({type:'source_port',source_port_id:'pg',name:'G',source_component_id:'u0',pin_number:9},
    {type:'source_net',source_net_id:'gnd',name:'GND',is_ground:true},
    {type:'source_trace',source_trace_id:'sg',connected_source_port_ids:['pg'],connected_source_net_ids:['gnd']},
    {type:'pcb_copper_pour',pcb_copper_pour_id:'pour',layer:'bottom',source_net_id:'gnd'})
  const {profiles,...modeling}=structuredClone(small.modeling)
  return {cj,modeling:{...modeling,channelReference:{sourcePortId:'pg'}}}
}

test('without a profile, a wire stage returns in the adjacent ground plane from pcb_stackup',()=>{
  const {cj,modeling}=withGroundPour()
  const g=geometryFromCircuitJson(cj,modeling)
  const ret=g.cells[0].conductors.at(-1)
  assert.equal(ret.name,'return')
  assert.equal(ret.parts,undefined)
  assert.ok(Math.abs(ret.zM+.235e-3)<1e-12)          // centres: top 0.0175 + 0.2 + 0.0175 mm
  assert.ok(Math.abs(ret.thicknessM-.035e-3)<1e-12)
  assert.ok(Math.abs(ret.widthM-2e-3)<1e-12)
  assert.equal(g.cells[0].relativePermittivity,4.1)
  // Lane spacing is measured from the routes when no profile declares it.
  const [a,b]=g.cells[0].conductors
  assert.ok(Math.abs(Math.abs(a.yM-b.yM)-.75e-3)<1e-9)
})

test('without a ground pour next to the layer, the missing return is explicit',()=>{
  const {profiles,...modeling}=small.modeling
  assert.throws(()=>geometryFromCircuitJson(small.circuitJson,modeling),/return_geometry: top: no adjacent copper layer carries a ground pour/)
})

test('a stripline gets one return bar in each adjacent ground plane',()=>{
  const copper=(layer,thickness=.0152)=>({layer_type:'copper',layer,thickness})
  const dielectric=(thickness,relative_permittivity)=>({layer_type:'dielectric',thickness,relative_permittivity})
  const stackup=stackupFromCircuitJson([{type:'pcb_board',pcb_board_id:'b',num_layers:4,thickness:1},
    {type:'pcb_stackup',pcb_stackup_id:'s',pcb_board_id:'b',layers:[copper('top',.035),dielectric(.0994,4.1),copper('inner1'),
      dielectric(.2,4.36),copper('inner2'),dielectric(.1088,4.16),copper('bottom')]}])
  const r=stackupStageReturn(stackup,new Set(['inner1','bottom']),'inner2')
  assert.deepEqual(r.parts.map(p=>p.layer).sort(),['bottom','inner1'])
  const z=Object.fromEntries(r.parts.map(p=>[p.layer,p.centerZMm]))
  assert.ok(Math.abs(z.inner1-.2152)<1e-9&&Math.abs(z.bottom+(.0076+.1088+.0076))<1e-9)
  assert.ok(Math.abs(r.relativePermittivity-(.2*4.36+.1088*4.16)/.3088)<1e-12)
  assert.deepEqual(stackupStageReturn(stackup,new Set(['inner1','bottom']),'top').parts.map(p=>p.layer),['inner1'])
})

test('a multi-part return is one conductor in both solver decks',()=>{
  const cell={stage:0,profile:'inner2',relativePermittivity:4.3,conductivitySm:5.8e7,conductors:[
    {name:'sig0',lengthM:.01,widthM:1e-4,thicknessM:1.52e-5,yM:0,zM:0},
    {name:'return',lengthM:.01,widthM:2e-3,thicknessM:1.52e-5,yM:0,zM:2.152e-4,conductivitySm:5.8e7,
      parts:[{widthM:2e-3,thicknessM:1.52e-5,yM:0,zM:2.152e-4},{widthM:2e-3,thicknessM:1.52e-5,yM:0,zM:-1.24e-4}]}]}
  const settings={filaments:3,minimumHz:1,maximumHz:1e9,maxPanelLengthMm:2}
  const fh=fastHenryDeck(cell,settings)
  assert.match(fh,/^E1 N1a N1b w=0.002 h=0.0000152/m)
  assert.match(fh,/^E1p1 N1a1 N1b1 /m)
  assert.match(fh,/^\.equiv N1a N1a1$/m)
  assert.match(fh,/^\.equiv N1b N1b1$/m)
  assert.equal(fh.match(/^\.external/gm).length,2)
  const fc=fasterCapDeck(cell,settings)
  assert.equal(fc['channel.lst'].trim().split('\n').filter(l=>l.startsWith('C ')).length,2)
  const zs=new Set(fc['return.txt'].split('\n').filter(l=>l.startsWith('Q')).flatMap(l=>l.split(' ').slice(2).filter((_,k)=>k%3===2)))
  assert.ok(zs.has(String(2.152e-4+.76e-5))&&[...zs].some(z=>Number(z)<0))
})
