import { fail } from './diagnostics'

interface ScopeRecord { type: string; [key: string]: unknown }

/**
 * Saved subcircuits nest: a board subcircuit can contain sibling subcircuits
 * (for example a processor and its DDR memory). A channel between siblings
 * belongs to their nearest common subcircuit. `undefined` is the unscoped root.
 */
export function subcircuitTree(records: readonly ScopeRecord[]) {
  const groups = new Map(records.filter(record => record.type === 'source_group').map(record => [record.source_group_id, record]))
  const parents = new Map<unknown, unknown>()
  for (const group of groups.values()) {
    if (!group.subcircuit_id || parents.has(group.subcircuit_id)) continue
    let parent: unknown
    let groupId = group.parent_source_group_id
    const visited = new Set<unknown>()
    while (groupId) {
      if (visited.has(groupId)) fail('simulation_scope', 'Cyclic source-group ownership')
      visited.add(groupId)
      const ancestor = groups.get(groupId)
      if (!ancestor) break
      if (ancestor.subcircuit_id && ancestor.subcircuit_id !== group.subcircuit_id) { parent = ancestor.subcircuit_id; break }
      groupId = ancestor.parent_source_group_id
    }
    parents.set(group.subcircuit_id, parent)
  }
  const chain = (scope: unknown): unknown[] => {
    const scopes: unknown[] = []
    for (let current = scope; current !== undefined && current !== null; current = parents.get(current)) {
      if (scopes.includes(current)) fail('simulation_scope', 'Cyclic subcircuit ownership')
      scopes.push(current)
    }
    return [...scopes, undefined]
  }
  /** True when `inner` is `outer` or nested inside it. */
  const within = (inner: unknown, outer: unknown) => chain(inner).includes(outer ?? undefined)
  /** Nearest subcircuit containing every scope. */
  const common = (scopes: readonly unknown[]): unknown => {
    if (!scopes.length) return undefined
    const chains = scopes.map(chain)
    return chains[0].find(scope => chains.every(other => other.includes(scope)))
  }
  return { within, common }
}
export type SubcircuitTree = ReturnType<typeof subcircuitTree>
