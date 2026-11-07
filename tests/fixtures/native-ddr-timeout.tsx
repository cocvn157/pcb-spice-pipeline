import { Circuit, analog } from '@tscircuit/core'
import React from 'react'
import { modelingFromCircuitJson } from '../../src/pipeline'
import { geometryFromCircuitJson } from '../../src/board'
import { fastHenryDeck } from '../../src/extraction'

const lanes = ['DQ', 'DQS', 'DQSn'] as const
let state = 0x7f
const prbs7 = Array.from({ length: 127 }, () => {
  const bit = state & 1
  state = (state >> 1) | (((state ^ (state >> 1)) & 1) << 6)
  return bit
}).join('')
const channel = {
  reduction: 'routed-copper' as const, sections: 12, relativePermittivity: 4.1,
  lanes: lanes.map(name => ({ name, from: `.U1 > .${name}`, to: `.U3 > .${name}` })),
  referencePinRef: '.U1 > .GND',
  extraction: { minimumFrequency: '1Hz', maximumFrequency: '1GHz', modelFrequency: '100MHz',
    filaments: 3, refinementFilaments: 5, convergenceTolerance: .05, capacitanceTolerance: .02,
    reciprocityTolerance: .025, dcResistanceTolerance: .002, maxPanelLength: '2mm', groundMeshSize: '3mm' },
  via: { platingThickness: '.025mm', equivalentWidth: '.1mm', omitThroughViaStubs: true },
}

// Extraction-only reduction of the AM3352 DDR timeout. No vendor model or eye
// result is needed to reproduce the process deadline before transient analysis.
export default function NativeDdrTimeout() {
  return <board width={20} height={14} layers={4} thickness={1.6}
    fabricatorPreset="jlcpcb_standard" routeRemaining={false} schematicDisabled>
    {(['U1', 'U3'] as const).map((name, i) => <React.Fragment key={name}>
      <chip name={name} pcbX={i ? 6 : -6} pcbY={0}
        pinLabels={{ pin1: 'DQ', pin2: 'DQS', pin3: 'DQSn', pin4: 'GND' }}
        connections={{ GND: 'net.GND' }} footprint={<footprint>
          {['DQ', 'DQS', 'DQSn', 'GND'].map((_, p) => <React.Fragment key={p}><smtpad
            portHints={[`pin${p + 1}`]} pcbX={0} pcbY={1 - p} width={.3} height={.3} shape="rect" /></React.Fragment>)}
        </footprint>} />
      {/* Declaration only: this extraction test never opens an IBIS file. */}
      <silkscreentext text={name} pcbX={i ? 6 : -6} pcbY={2} fontSize={.8} />
      <ibismodel componentRef={`chip.${name}`} ibisComponentName="TEST"
        ibisModelAsset={{ project_relative_path: 'extraction-only.ibs', url: './extraction-only.ibs', mimetype: 'text/plain' }}
        ibisPinNameToPortLabel={{ '1': 'DQ', '2': 'DQS', '3': 'DQSn', '4': 'GND' }}
        modelValueCorner="typical" includePackageParasitics={false} />
      <via name={`GND_${name}`} pcbX={(i ? 6 : -6) + .4} pcbY={-2}
        holeDiameter={.2} outerDiameter={.4} layers={['top', 'inner1', 'inner2', 'bottom']} connectsTo="net.GND" />
      <trace from={`.${name} > .GND`} to={`.GND_${name} > .top`} width={.15}
        connectsTo={[`.${name} > .GND`, `.GND_${name} > .top`, 'net.GND']}
        pcbPath={[`.${name} > .GND`, `.GND_${name} > .top`]} />
    </React.Fragment>)}
    {lanes.map(name => <trace key={name} name={`${name}_ROUTE`} from={`.U1 > .${name}`}
      to={`.U3 > .${name}`} width={.1} pcbPath={[`.U1 > .${name}`, `.U3 > .${name}`]} />)}
    {lanes.map((name, i) => <React.Fragment key={name}><silkscreentext text={name} pcbX={0} pcbY={1.3 - i} fontSize={.4} /></React.Fragment>)}
    <net name="GND" />
    <copperpour name="REFERENCE" layer="bottom" connectsTo="net.GND" unbroken
      outline={[{ x: -9, y: -6 }, { x: 9, y: -6 }, { x: 9, y: 6 }, { x: -9, y: 6 }]} />
    <voltageprobe name="DQ_RX" connectsTo=".U3 > .DQ" referenceTo=".U3 > .GND" />
    <voltageprobe name="DQS_RX" connectsTo=".U3 > .DQS" referenceTo=".U3 > .DQSn" />
    <analog.transientsimulation name="WRITE" spiceEngine="pcb_spice" duration="512ns" timePerStep="10ps" pcbSpiceChannel={channel}
      ibisPinStates={Object.fromEntries(lanes.map(name => [`.U1 > .${name}`, { isOutput: true, isOutputEnabled: true }]))} />
    {lanes.map((name, i) => <analog.digitalstimulus key={name} name={name} simulationRef=".WRITE"
      sourcePinRef={`.U1 > .${name}`} bitDuration="1.5625ns" startTime={i ? '.78125ns' : '0ns'}
      initialState={0} inverted={i === 2} transmittedData={{ transmissionType: 'bits', bits: i ? '01' : prbs7, repeat: true }} />)}
    <analog.eyediagram name="DQ_EYE" simulationRef=".WRITE" probeRef=".DQ_RX" unitInterval="1.5625ns" timeOrigin="0ns" startTime="40ns" />
    <analog.eyediagram name="DQS_EYE" simulationRef=".WRITE" probeRef=".DQS_RX" unitInterval="1.5625ns" timeOrigin=".78125ns" startTime="40ns" />
  </board>
}

export async function nativeDdrTimeout() {
  const circuit = new Circuit({ platform: { partsEngineDisabled: true } })
  circuit.add(<NativeDdrTimeout />)
  await circuit.renderUntilSettled()
  const records = circuit.getCircuitJson()
  const modeling = { ...modelingFromCircuitJson(records), groundReturn: { component: 'U3', port: 'GND' } }
  const geometry = geometryFromCircuitJson(records, modeling)
  const deck = fastHenryDeck(geometry.cells[0], { ...modeling.extraction,
    minimumHz: modeling.extraction.modelHz, maximumHz: modeling.extraction.modelHz,
    filaments: modeling.extraction.refinementFilaments, groundMeshMm: modeling.extraction.groundMeshMm! / 2 })
  return { records, deck }
}
