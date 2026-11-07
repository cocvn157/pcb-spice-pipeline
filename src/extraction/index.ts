/**
 * extraction — what the channel is electrically.
 * Owns: meshing (ground mesh, copper surface triangulation, panel sizing), FastHenry/FasterCap
 * decks from board's Geometry, native-output parsing and log scans, coarse/refined convergence,
 * reciprocity/passivity/DC-R/capacitance-sign/energy checks, the linear algebra those need, and the
 * RLGC subcircuit text (channel.cir).
 * Artifacts: today's stage-N/** (decks, solver logs/requests/outputs, extraction.json) and channel.cir.
 * Imports: kernel, solver, board. (Was: extraction.ts, matrices.mjs, deck halves of
 * geometry.ts/copper.ts, spice.ts channelSpice.)
 */
export type { ExtractionSettings, ExtractionModeling, ExtractedChannel, ExtractedStage, ChannelMatrices, Matrix, ImpedanceSample, MatrixCheck, CapacitanceCheck, RefinementCheck } from './types'
export { extractChannel } from './extract'
export { channelSpice, type StageMatrices } from './rlgc'
export { fastHenryDeck, fasterCapDeck, copperFastHenryDeck, copperFasterCapDeck, copperCapacitanceScaleToFarads } from './decks'
export { groundMesh, meshPolygon, copperPanelSizing, panelAspectLimit, panelGrading, type PanelSizing } from './mesh'
export { validateMatrix, loopImpedance, referenceCapacitance } from './checks'
export { parseFastHenry, parseFasterCap, type CapacitanceOutput } from './parse'
export { sum, scale, transpose, multiply, symmetrize } from './linalg'
