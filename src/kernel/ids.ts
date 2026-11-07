import { fail } from './fail.js'
declare const idBrand: unique symbol
/** /^[a-zA-Z0-9_-]+$/ — safe as a path segment and a SPICE identifier fragment. */
export type SafeId = string & { readonly [idBrand]: true }
/** Boundary parse. Inside the library every id that reaches a path or netlist is a SafeId. */
export function safeId(raw: unknown, field: string): SafeId {
  void field // message kept byte-identical to the pre-module pipeline
  if (typeof raw !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(raw))
    fail('simulation_id', 'Serialized simulation IDs must be safe stable identifiers')
  return raw as SafeId
}
