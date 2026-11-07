import { mkdir, writeFile } from 'node:fs/promises'
import { nativeChannel, modeling, curvedPoints } from '../tests/fixtures/native-channel'
import { geometryFromCircuitJson } from '../src/board'
import { fasterCapDeck } from '../src/extraction'
import { circuitNodes } from '../src/simulation'

const directory = new URL('../tests/reproductions/native-channel/', import.meta.url)
const cases = [
  { title: '1 / Native via dimensions', options: { vias: true }, lines: ['Look at the two highlighted via-in-pad transitions.', 'The native pcb_via records contain 0.2 mm holes.', 'The trace via vertices omit dimensions.'] },
  { title: '2 / Net binding bypass', options: { netBindings: true }, lines: ['The solid copper trace is the selected channel.', 'Dashed links show both pins bound to net.DQ.', 'The extracted model needs distinct endpoints.'] },
  { title: '3 / Copper union precision', options: { points: curvedPoints }, lines: ['Zoom: the short diagonal joins the long segment.', 'Only 3 native path points; width = 0.1 mm.', 'Copper slabs must join at this bend.'] },
]
/** Escapes text for safe embedding inside SVG markup. */
const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1260" height="510" viewBox="0 0 1260 510"><rect width="1260" height="510" fill="#0b1422"/><g font-family="sans-serif" fill="#eef4ff"><text x="24" y="36" font-size="22">Native TSX channel preparation</text>'
const logs: string[] = []
for (const [i, item] of cases.entries()) {
  const circuit = await nativeChannel(item.options)
  let failure = 'Prepared successfully'
  try {
    const geometry = geometryFromCircuitJson(circuit, modeling)
    circuitNodes(circuit, geometry, modeling)
    fasterCapDeck(geometry.cells[0], modeling.extraction)
  } catch (error) { failure = (error as Error).message }
  logs.push(`${item.title}\n${failure}\n`)
  const source = circuit.find(e => e.type === 'source_trace' && e.name === 'DQ_ROUTE')!
  if (source.type !== 'source_trace') throw Error('Missing native trace')
  const trace = circuit.find(e => e.type === 'pcb_trace' && e.source_trace_id === source.source_trace_id)!
  if (trace.type !== 'pcb_trace') throw Error('Missing native copper')
  const route = trace.route
  const x0 = i * 412 + 16
  const xs = route.map(p => p.x)
  const ys = route.map(p => p.y)
  const scale = Math.min(310 / Math.max(.6, Math.max(...xs) - Math.min(...xs)), 150 / Math.max(.6, Math.max(...ys) - Math.min(...ys)))
  /** Maps a board x coordinate (mm) to a horizontal pixel in this panel, centred on the route. */
  const px = (x: number): number => 198 + (x - (Math.min(...xs) + Math.max(...xs)) / 2) * scale
  /** Maps a board y coordinate (mm) to a vertical pixel in this panel; SVG y grows downward, so it is flipped. */
  const py = (y: number): number => 216 - (y - (Math.min(...ys) + Math.max(...ys)) / 2) * scale
  svg += `<g transform="translate(${x0} 0)"><rect x="0" y="60" width="400" height="425" rx="12" fill="#142439"/><text x="18" y="92" font-size="19">${item.title}</text><rect x="15" y="112" width="370" height="208" rx="8" fill="#12352f"/>`
  svg += `<polyline points="${route.map(p => `${px(p.x)},${py(p.y)}`).join(' ')}" fill="none" stroke="#ffca67" stroke-width="${Math.max(3, .1 * scale)}" stroke-linejoin="round" stroke-linecap="round"/>`
  for (const p of [route[0], route.at(-1)!]) svg += `<circle cx="${px(p.x)}" cy="${py(p.y)}" r="${i === 2 ? 4 : 8}" fill="#e8b962" stroke="#091a1a" stroke-width="2"/>`
  for (const p of i === 0 ? route.filter(p => p.route_type === 'via') : i === 2 ? [route[1]] : []) svg += `<circle cx="${px(p.x)}" cy="${py(p.y)}" r="${i === 2 ? 23 : 19}" fill="none" stroke="#ff6e75" stroke-width="3"/>`
  if (i === 1) svg += `<path d="M ${px(route[0].x)} 206 V 145 H ${px(route.at(-1)!.x)} V 206" fill="none" stroke="#ff6e75" stroke-width="2" stroke-dasharray="6 4"/><text x="168" y="139" font-size="14" fill="#ffa3a8">net.DQ</text>`
  if (i < 2) svg += '<text x="31" y="250" font-size="14">TX.DQ</text><text x="311" y="250" font-size="14">RX.DQ</text>'
  item.lines.forEach((line, j) => {
    svg += `<text x="18" y="${349 + j * 22}" font-size="14">${escape(line)}</text>`
  })
  svg += `<text x="18" y="440" font-size="15" fill="${failure === 'Prepared successfully' ? '#7de7af' : '#ffa3a8'}">${escape(failure.includes('SweepLine') ? 'Unable to find segment in SweepLine tree' : failure.split(':')[0])}</text><text x="18" y="465" font-size="12" fill="#a7b9cf">Trace coordinates rendered from native Circuit output</text></g>`
}
svg += '</g></svg>\n'
await mkdir(directory, { recursive: true })
await writeFile(new URL('before.svg', directory), svg)
console.log(logs.join('\n'))
