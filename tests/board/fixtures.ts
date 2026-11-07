// Every repo board fixture with the modeling the old suite uses for it. Shared by the golden tests.
import { readFileSync } from 'node:fs'
import type { CircuitJson } from 'circuit-json'
import type { Modeling } from '../../src/board'
import { groundPlaneFixture, routedGroundPlaneFixture } from '../fixtures/ground-plane'
import { nativeChannel, modeling as nativeModeling, curvedPoints } from '../fixtures/native-channel'
import { viaInPad } from '../fixtures/via-in-pad'

const read = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'))
export interface BoardCase { name: string; circuit: CircuitJson; modeling: Modeling }

export async function boardCases(): Promise<BoardCase[]> {
  const straight = { circuit: read('straight.circuit.json'), modeling: read('straight.modeling.json') }
  const am3352 = { circuit: read('am3352.circuit.json'), modeling: read('am3352.modeling.json') }
  // stage-returns.test: straight board + GND pour, no declared profile => stackup-derived return.
  const pour = structuredClone(straight)
  pour.circuit.push({type:'source_port',source_port_id:'pg',name:'G',source_component_id:'u0',pin_number:9},
    {type:'source_net',source_net_id:'gnd',name:'GND',is_ground:true},
    {type:'source_trace',source_trace_id:'sg',connected_source_port_ids:['pg'],connected_source_net_ids:['gnd']},
    {type:'pcb_copper_pour',pcb_copper_pour_id:'pour',layer:'bottom',source_net_id:'gnd'})
  delete pour.modeling.profiles
  pour.modeling.channelReference = { sourcePortId: 'pg' }
  const dq0 = structuredClone(am3352)
  dq0.modeling.lanes.unshift({port:'DQ0',from:{component:'U1',port:'M3'},to:{component:'U3',port:'E3'}})
  const routed = routedGroundPlaneFixture()
  return [
    { name: 'straight', ...straight },
    { name: 'am3352', ...am3352 },
    { name: 'am3352+DQ0', ...dq0 },
    { name: 'straight+stackup-return', ...pour },
    { name: 'ground-plane (routed)', ...groundPlaneFixture() },
    { name: 'routed ground lead', circuit: routed.circuit, modeling: routed.modeling },
    { name: 'native vias', circuit: await nativeChannel({ vias: true }), modeling: nativeModeling },
    { name: 'native curved', circuit: await nativeChannel({ points: curvedPoints }), modeling: nativeModeling },
    { name: 'via-in-pad', circuit: await viaInPad(), modeling: nativeModeling },
    { name: 'via-in-pad offset', circuit: await viaInPad({ offset: .04 }), modeling: nativeModeling },
  ]
}
