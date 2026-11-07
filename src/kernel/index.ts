/**
 * kernel — the only module every other module may import.
 * Owns: the diagnostic model, artifact values + the single-writer ledger, safe ids,
 * hashing. No domain knowledge.
 * Imports: nothing in src/ except ../modules.generated (types only).
 */
export { Diagnostic, diagnostics, type DiagnosticSubject, type DiagnosticInit } from './diagnostic.js'
export { type Artifact, type ArtifactPath, type ArtifactScope, type FileMap, type Produced, ArtifactLedger, rootScope, artifactPath, jsonBody } from './artifacts.js'
export { type SafeId, safeId } from './ids.js'
export { sha256 } from './hash.js'

