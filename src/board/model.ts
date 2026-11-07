import type { Artifact, ArtifactScope } from '../kernel/index.js'
import type { CircuitJson } from './schema.js'
import { validateCircuitRecords } from './schema.js'

declare const boardBrand: unique symbol
/**
 * Admitted board: Circuit JSON whose every record passed its registered schema.
 * Downstream modules can take a Board to know "validated?" by type. The records are
 * the caller's objects, unchanged (validation never rewrites input).
 */
export interface Board {
  readonly circuitJson: CircuitJson
  readonly [boardBrand]: true
}

/** Boundary: unknown JSON -> Board. Fails 'circuit_schema' naming the first bad record (today's validateCircuitRecords). */
export function admitBoard(circuitJson: unknown): Board {
  validateCircuitRecords(circuitJson)
  return { circuitJson: circuitJson as CircuitJson } as Board
}

/** `inputs/circuit.json` under the given (root) scope, byte-identical to today's jsonFile. */
export function circuitArtifact(board: Board, scope: ArtifactScope): Artifact {
  return scope.child('inputs').json('circuit.json', board.circuitJson)
}
