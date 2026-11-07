// Today's geometry.json shapes (was geometry.ts + copper.ts types). Serialized: do not reorder or rename.
import type { CircuitJson } from '../schema.js'
import type { BoardStackup, CopperLayer } from '../stackup.js'

export type PortSelector = { sourcePortId: string; component?: never; port?: never } | { sourcePortId?: never; component: string; port: string }
export interface ExtractionSettings {
  minimumHz: number; maximumHz: number; modelHz: number
  filaments: number; refinementFilaments: number; convergenceTolerance: number
  capTolerance: number; maxPanelLengthMm: number; reciprocityTolerance: number; dcResistanceTolerance: number
  groundMeshMm?: number
}
export interface ReturnProfile {
  spacingMm: number; relativePermittivity: number; return: {
    widthMm: number; thicknessMm: number; lengthFactor: number; centerYMm: number; centerZMm: number
  }
}
export interface LaneModeling { port: string; from: PortSelector; to: PortSelector; sourceTraceId?: string; driverPort?: string; receiverPort?: string }
/**
 * board's slice of the flat public `Modeling`: every field geometryFromCircuitJson reads or
 * validates (validateModeling also checks `extraction` and `sections`, as today).
 * `ddrAssessments` (ddr), `supplies` / `passiveComponents` (simulation) are other slices.
 */
export interface BoardModeling {
  reduction: 'straightened-stages' | 'routed-copper'; sections: number
  relativePermittivity?: number
  groundReturn?: PortSelector
  lanes: LaneModeling[]
  profiles?: Record<string, ReturnProfile>
  extraction: ExtractionSettings
  viaPlatingMm?: number; viaEquivalentWidthMm?: number; omitThroughViaStubs?: boolean
  channelReference?: PortSelector
  description?: string
}
/** Alias: the geometry-facing Modeling. The full public Modeling is pipeline's intersection of slices. */
export type Modeling = BoardModeling
export interface ResolvedModeling extends BoardModeling {
  conductivitySm: number
  stackup: CopperLayer[]
}
export interface RouteStage {
  kind: 'wire' | 'via'; profile: string; lengthMm: number; widthMm: number; thicknessMm: number
  conductivitySm?: number
  holeMm?: number; platingMm?: number
}
export type SourcePort = Extract<CircuitJson[number], { type: 'source_port' }>
export type PcbTrace = Extract<CircuitJson[number], { type: 'pcb_trace' }>
export type RoutePoint = PcbTrace['route'][number]
export type RoutedPoint = Exclude<RoutePoint, { route_type: 'through_pad' }>

export interface LaneMapping {
  port: string; sourceTraceId: string; pcbTraceId: string; from: string; to: string
  pcbPorts: string[]; stages: RouteStage[]; originalRoute: RoutedPoint[]
}

/** Routed-copper data in mm, unmeshed (meshing is extraction's). Shape = geometry.json `routedCopper`. */
export type CopperPoint = [number, number]
export type CopperXYZ = [number, number, number]
export type CopperPolygon = CopperPoint[][]
export type CopperSolid = { polygon: CopperPolygon; zMinMm: number; zMaxMm: number; conductivitySm?: number }
export type CopperSegment = { conductivitySm?: number; a: CopperXYZ; b: CopperXYZ; widthMm: number; thicknessMm: number }
export type CopperPath = { segments: CopperSegment[]; terminals: [CopperXYZ, CopperXYZ]; contactRadiusMm?: number }
export type CopperPour = CopperSolid & { pcbCopperPourId: string; layer: string }
export interface RoutedCopper {
  sourceNetId: string
  sourceNetName: string
  referenceSourcePortIds: string[]
  pours: CopperPour[]
  signals: CopperPath[]
  connections: CopperPath[]
}
export type Conductor = { name: string; lengthM: number; widthM: number; thicknessM: number; yM: number; zM: number; conductivitySm?: number; parts?: { widthM: number; thicknessM: number; yM: number; zM: number }[] }
export interface GeometryCell {
  stage: number; profile: string; relativePermittivity: number; conductivitySm: number
  /** `parts`: parallel boxes joined at both ends forming one conductor (e.g. a
   * stripline return in both adjacent planes). The scalar fields are part 0. */
  conductors: Conductor[]
  routedCopper?: RoutedCopper
}
export interface Geometry {
  stackup?: BoardStackup
  cells: GeometryCell[]; mappings: LaneMapping[]
  units: { circuitJson: 'mm'; geometry: 'm'; conductivity: 'S/m' }; approximations: string[]
}
/** Stub-era name for Geometry, kept for modules already coding against it. */
export type ChannelGeometry = Geometry
