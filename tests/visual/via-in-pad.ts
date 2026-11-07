import { writeFileSync } from 'node:fs'
import { convertCircuitJsonToPcbSvg } from 'circuit-to-svg'
import { viaInPad } from '../fixtures/via-in-pad'

const circuit = await viaInPad()
for (const layer of ['top', 'inner1'] as const) {
  const svg = convertCircuitJsonToPcbSvg(circuit, { layer, width: 900, height: 600 })
  writeFileSync(new URL(`./via-in-pad-${layer}.svg`, import.meta.url), svg)
}
