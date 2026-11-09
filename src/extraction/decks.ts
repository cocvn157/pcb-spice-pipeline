// FastHenry / FasterCap deck text (was geometry.ts fastHenryDeck/fasterCapDeck + copper.ts copper*Deck).
import { polygonContains as contains, type CopperPoint as Point, type CopperXYZ as XYZ, type CopperPath as Path,
  type ExtractionSettings, type GeometryCell } from '../board'
import { groundMesh, pathSolids, surfacePanels, copperPanelSizing } from './mesh'

// FasterCap has absolute panel-area thresholds. Millimetre coordinates keep
// real fine copper edges numerically resolvable. Electrostatic capacitance
// scales linearly with length, so rescale the raw matrix back to SI farads.
export const copperCapacitanceScaleToFarads=1e-3

/** FastHenry conductor mesh follows the selected polygon, including every cutout. */
export function copperFastHenryDeck(cell: GeometryCell, extraction: ExtractionSettings): string {
  const copper = cell.routedCopper!
  const mesh = extraction.groundMeshMm!
  const lines = ['* Actual routed signals and inferred ground copper; dimensions in metres', '.units m', `.default sigma=${cell.conductivitySm} nhinc=${extraction.filaments} nwinc=${extraction.filaments}`]
  /** Formats a millimetre point as FastHenry node coordinates in metres. */
  const coordinates = (p: XYZ): string => `x=${p[0] / 1000} y=${p[1] / 1000} z=${p[2] / 1000}`
  let serial = 0
  /** Emits one copper path as a chain of FastHenry segments from node a to node b (or an .equiv when the path has no segments). */
  const path = (p: Path, a: string, b: string): void => {
    if (!p.segments.length) {
      lines.push(`${a} ${coordinates(p.terminals[0])}`)
      if (a !== b) lines.push(`${b} ${coordinates(p.terminals[0])}`, `.equiv ${a} ${b}`)
      return
    }
    const names = [a, ...p.segments.slice(1).map(() => `Nt${serial++}`), b]
    lines.push(`${names[0]} ${coordinates(p.segments[0].a)}`)
    for (const [i, s] of p.segments.entries()) {
      lines.push(`${names[i + 1]} ${coordinates(s.b)}`)
      const dx = s.b[0] - s.a[0]
      const dy = s.b[1] - s.a[1]
      const horizontal = Math.hypot(dx, dy)
      lines.push(`E${serial++} ${names[i]} ${names[i + 1]} w=${s.widthMm / 1000} h=${s.thicknessMm / 1000} sigma=${s.conductivitySm??cell.conductivitySm} wx=${horizontal ? -dy / horizontal : 1} wy=${horizontal ? dx / horizontal : 0} wz=0`)
    }
  }
  copper.signals.forEach((p, i) => path(p, `N${i}a`, `N${i}b`))
  const n = copper.signals.length
  copper.connections.forEach((p, i) => path(p, `N${n}${i ? 'b' : 'a'}`, `Ng${i}`))
  for (const [index, pour] of copper.pours.entries()) {
    const contacts = copper.connections.map((p, i) => ({ p, i })).filter(({ p }) => Math.abs((pour.zMinMm + pour.zMaxMm) / 2 - p.terminals[1][2]) < 1e-8 && contains(p.terminals[1].slice(0, 2) as Point, pour.polygon))
    const ground = groundMesh(pour, mesh, contacts.map(({p})=>({point:p.terminals[1].slice(0,2) as Point,radius:p.contactRadiusMm!})),Math.max(2,Math.ceil(Math.sqrt(extraction.filaments))))
    const zz = (pour.zMinMm + pour.zMaxMm) / 2000
    const thickness = (pour.zMaxMm - pour.zMinMm) / 1000
    lines.push(`* ${pour.pcbCopperPourId} layer=${pour.layer} cutouts=${pour.polygon.length-1} meshMm=${mesh}`)
    ground.points.forEach((p,j)=>lines.push(`Np${index}_${j} x=${p[0]/1000} y=${p[1]/1000} z=${zz}`))
    ground.edges.forEach(([a,b,width],j)=>{
      const [u,v]=[ground.points[a],ground.points[b]]
      const dx=v[0]-u[0]
      const dy=v[1]-u[1]
      const length=Math.hypot(dx,dy)
      lines.push(`Eg${index}_${j} Np${index}_${a} Np${index}_${b} w=${width/1000} h=${thickness} sigma=${pour.conductivitySm??cell.conductivitySm} wx=${-dy/length} wy=${dx/length} wz=0 nwinc=1 nhinc=${extraction.filaments}`)
    })
    contacts.forEach(({i},j)=>ground.contacts[j].forEach(id=>lines.push(`.equiv Ng${i} Np${index}_${id}`)))
  }
  for (let i = 0; i <= n; i++) lines.push(`.external N${i}a N${i}b`)
  lines.push(`.freq fmin=${extraction.minimumHz} fmax=${extraction.maximumHz} ndec=1`, '.end')
  return lines.join('\n') + '\n'
}

/** FasterCap panel files for routed copper: one surface file per signal plus one for the return (pours and ground connections), in millimetres. */
export function copperFasterCapDeck(cell: GeometryCell, extraction?: Pick<ExtractionSettings, 'maxPanelLengthMm'>): Record<string, string> {
  const copper = cell.routedCopper!
  const files: Record<string, string> = {}
  const list = ['* Actual routed copper in millimetres; physical capacitance = raw matrix * 0.001; homogeneous dielectric']
  const solids = [...copper.signals.map(pathSolids), [...copper.pours, ...copper.connections.flatMap(pathSolids)]]
  const sizing = extraction ? copperPanelSizing(copper, extraction.maxPanelLengthMm) : undefined
  solids.forEach((pieces, i) => {
    const name = i === copper.signals.length ? 'return' : `sig${i}`
    files[`${name}.txt`] = surfacePanels(pieces, name, sizing)
    list.push(`C ${name}.txt ${cell.relativePermittivity} 0 0 0`)
  })
  files['channel.lst'] = list.join('\n') + '\n'
  return files
}

/** FastHenry input for a cell: routed copper gets the full polygon deck, otherwise straight +x bars for each conductor part. */
export function fastHenryDeck(cell: GeometryCell,extraction: ExtractionSettings): string {
  if(cell.routedCopper) return copperFastHenryDeck(cell,extraction)
  const lines=[`* PCB pipeline: ${cell.conductors.length} primitive paths, all oriented +x`,'.units m',`.default sigma=${cell.conductivitySm} nhinc=${extraction.filaments} nwinc=${extraction.filaments}`]
  for(const [i,c] of cell.conductors.entries()) for(const [k,p] of (c.parts??[c]).entries()) {
    const lengthM=p.lengthM??c.lengthM
    const [a,b]=k?[`N${i}a${k}`,`N${i}b${k}`]:[`N${i}a`,`N${i}b`]
    lines.push(`${a} x=0 y=${p.yM} z=${p.zM}`,`${b} x=${lengthM} y=${p.yM} z=${p.zM}`,`E${i}${k?`p${k}`:''} ${a} ${b} w=${p.widthM} h=${p.thicknessM} sigma=${c.conductivitySm??cell.conductivitySm} wx=0 wy=1 wz=0`)
    if(k) lines.push(`.equiv N${i}a ${a}`,`.equiv N${i}b ${b}`)
  }
  for(let i=0;i<cell.conductors.length;i++) lines.push(`.external N${i}a N${i}b`)
  lines.push(`.freq fmin=${extraction.minimumHz} fmax=${extraction.maximumHz} ndec=1`,'.end')
  return lines.join('\n')+'\n'
}
/** FasterCap input files for a cell: routed copper gets surface panels, otherwise each conductor is a closed box split along its length. */
export function fasterCapDeck(cell: GeometryCell,extraction: ExtractionSettings): Record<string,string> {
  if(cell.routedCopper) return copperFasterCapDeck(cell,extraction)
  const files: Record<string,string>={}
  const list=['* 3D conductor surfaces; metres; homogeneous dielectric']
  for(const c of cell.conductors) {
    const rows=['* closed box conductor surface']
    /** Appends one quadrilateral panel of the current conductor to its surface file. */
    const quad=(vs: [number,number,number][]): number=>rows.push(`Q ${c.name} ${vs.flat().join(' ')}`)
    for(const p of c.parts??[c]) {
      const lengthM=p.lengthM??c.lengthM
      const n=Math.ceil(lengthM/(extraction.maxPanelLengthMm/1000))
      const y0=p.yM-p.widthM/2
      const y1=p.yM+p.widthM/2
      const z0=p.zM-p.thicknessM/2
      const z1=p.zM+p.thicknessM/2
      for(let k=0;k<n;k++) {
        const a=lengthM*k/n
        const b=lengthM*(k+1)/n
        quad([[a,y0,z0],[b,y0,z0],[b,y1,z0],[a,y1,z0]])
        quad([[a,y1,z1],[b,y1,z1],[b,y0,z1],[a,y0,z1]])
        quad([[a,y0,z1],[b,y0,z1],[b,y0,z0],[a,y0,z0]])
        quad([[a,y1,z0],[b,y1,z0],[b,y1,z1],[a,y1,z1]])
      }
      quad([[0,y0,z0],[0,y1,z0],[0,y1,z1],[0,y0,z1]])
      quad([[lengthM,y0,z1],[lengthM,y1,z1],[lengthM,y1,z0],[lengthM,y0,z0]])
    }
    files[`${c.name}.txt`]=rows.join('\n')+'\n'
    list.push(`C ${c.name}.txt ${cell.relativePermittivity} 0 0 0`)
  }
  files['channel.lst']=list.join('\n')+'\n'
  return files
}
