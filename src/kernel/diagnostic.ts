import type { DiagnosticCode, DomainName } from '../modules.generated'

/** What the diagnostic is about, so messages (#51, #52) can name records, not just say "failed". */
export interface DiagnosticSubject {
  kind: 'record' | 'lane' | 'cell' | 'experiment' | 'probe' | 'eye' | 'model' | 'artifact' | 'option' | 'solver'
  id: string
}
export interface DiagnosticInit {
  subjects?: readonly DiagnosticSubject[]
  /** Artifact paths (already in the ledger or the solver dir) that explain the failure: logs, decks. */
  artifacts?: readonly string[]
  /** One actionable sentence. */
  hint?: string
}

/**
 * The single error type thrown anywhere in the library.
 * `code` keeps today's bare strings ('vendor_hash', 'native_solver', ...) for back-compat;
 * `domain` says which module raised it. A code may be raised by more than one module.
 * message format stays `${code}: ${text}` so existing string matchers keep working.
 */
export class Diagnostic extends Error {
  readonly code: DiagnosticCode
  readonly domain: DomainName
  readonly subjects: readonly DiagnosticSubject[]
  readonly artifacts: readonly string[]
  readonly hint?: string
  constructor(domain: DomainName, code: DiagnosticCode, text: string, init: DiagnosticInit = {}) {
    super(`${code}: ${text}`)
    this.name = 'Diagnostic'
    this.domain = domain
    this.code = code
    this.subjects = init.subjects ?? []
    this.artifacts = init.artifacts ?? []
    this.hint = init.hint
  }
}

/**
 * Per-module failer. Each module calls this exactly once, in its own `diagnostics.ts`
 * (or index.ts for tiny modules); scripts/check-modules.ts parses the literal tuple to build
 * the global DiagnosticCode union in modules.generated.ts. A code not in the tuple is a type error.
 */
export function diagnostics<const D extends DomainName, const C extends readonly string[]>(domain: D, codes: C):
  (code: C[number] & DiagnosticCode, text: string, init?: DiagnosticInit) => never {
  void codes
  return (code, text, init) => {
    throw new Diagnostic(domain, code, text, init)
  }
}
