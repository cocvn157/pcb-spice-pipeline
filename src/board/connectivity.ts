import type { CircuitJson } from './schema'

/** Resolve net membership through electrical connections, never copper proximity. */
export function connectedSourceIds(circuit: CircuitJson, seed: string): Set<string> {
  const ids = new Set([seed])
  const traces = circuit.filter(e => e.type === 'source_trace')
  let changed = true
  while (changed) {
    changed = false
    for (const trace of traces) {
      const members = [...trace.connected_source_port_ids, ...(trace.connected_source_net_ids ?? [])]
      if (members.some(id => ids.has(id))) for (const id of members) if (!ids.has(id)) {
        ids.add(id)
        changed = true
      }
    }
  }
  return ids
}
