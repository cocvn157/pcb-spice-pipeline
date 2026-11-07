// Was src/model-source.ts. Messages and codes are byte-identical.
import { sha256 } from '../kernel'
import { fail } from './diagnostics'
import type { IbisSources, LoadedModelSource, ModelSourceRequest } from './types'

/** Portable relative paths used by the explicit Node adapter as well as file maps. */
export function relativeFile(path: string): string {
  if (!path || /[\\:\0]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..'))
    fail('file_path', `Expected a safe project-relative file path: ${path}`)
  return path
}

/**
 * Admits the caller-supplied IBIS bytes for one model: checks the path, size, format and UTF-8 text,
 * then records the SHA-256 evidence. Nothing is ever downloaded from the declared URL.
 */
export function loadModelSource(model: ModelSourceRequest, sources: IbisSources): LoadedModelSource {
  const asset = model.ibis_model_asset
  const path = relativeFile(asset.project_relative_path)
  if (!sources || !Object.hasOwn(sources, path)) fail('ibis_asset_missing', `Supply IBIS bytes for ${path} in ibisSources`)
  const source = sources[path]
  if (typeof source !== 'string' && !(source instanceof Uint8Array)) fail('ibis_asset', `${path}: expected a string or Uint8Array`)
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source
  if (bytes.length > 64 * 1024 * 1024) fail('ibis_asset', 'IBIS asset exceeds 64 MiB')
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) fail('ibis_asset', 'IBIS asset must be a plain .ibs file; extract ZIP archives explicitly')
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  if (/^\s*(?:<!doctype\s+html|<html)\b/i.test(text)) fail('ibis_asset', 'IBIS asset contains HTML instead of model data')
  const id = model.pipelineId
  const sourceSha256 = sha256(bytes)
  const ibsFile = `inputs/ibis/${id}.ibs`
  return { text, bytes, evidence: { simulationIbisModelId: id, ibisModelAsset: asset, resolvedFrom: 'provided', ibsFile, sourceSha256, rawSourceFile: ibsFile, rawSourceSha256: sourceSha256 } }
}
