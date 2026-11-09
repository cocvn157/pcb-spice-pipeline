/**
 * board — everything known about the physical board, read from Circuit JSON.
 * Owns: Circuit JSON admission (zod record schemas, subcircuit scope), stackup, port selection,
 * lane -> route resolution, and channel geometry for BOTH reductions (straightened stages +
 * stackup-derived returns; routed copper as UNMESHED mm polygons/paths). Never writes a deck:
 * meshing and decks are extraction's (they depend on ExtractionSettings and refinement).
 * Artifacts: inputs/circuit.json, geometry.json (today's `Geometry` bytes).
 * Imports: kernel. (Was: schema.ts, circuit-schema.mjs, stackup.ts, subcircuit-scope.ts,
 * geometry.ts minus decks, copper.ts minus meshing/decks, stage-returns.ts.)
 */
export type { CircuitJson, SimulationExperiment, SimulationIbisModel, SimulationIbisPinState, SimulationDigitalStimulus } from './schema'
export { parseRecord, recordSchema, validateCircuitRecords } from './schema'
export { type Board, admitBoard, circuitArtifact } from './model'
export { type BoardStackup, type CopperLayer, type DielectricLayer, stackupFromCircuitJson, defaultCopperConductivitySm } from './stackup'
export { subcircuitTree, type SubcircuitTree } from './subcircuit'
export { connectedSourceIds } from './connectivity'
export type {
  PortSelector, ExtractionSettings, ReturnBarProfile, ReturnProfile, LaneModeling, BoardModeling, Modeling, ResolvedModeling,
  RouteStage, SourcePort, PcbTrace, RoutePoint, RoutedPoint, LaneMapping, Conductor, GeometryCell, Geometry, ChannelGeometry,
  RoutedCopper, CopperPoint, CopperXYZ, CopperPolygon, CopperSolid, CopperSegment, CopperPath, CopperPour,
} from './geometry/types'
export { selectPort, resolveRouteVias } from './geometry/ports'
export { polygonContains, ringArea, closeRing } from './geometry/polygon'
export { derivedReturnWidthMm, groundPourLayers, stackupStageReturn, measuredLaneSpacingMm, type StageReturn, type StageReturnPart } from './geometry/returns'
export { validateModeling, geometryFromCircuitJson, channelGeometry } from './geometry'
