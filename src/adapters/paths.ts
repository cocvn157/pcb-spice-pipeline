import { isAbsolute, relative } from 'node:path'
import { fail } from './diagnostics'

/** Same rule as model-source.ts relativeFile (buffers owns the IBIS copy; adapters keeps its own). */
export function relativeFile(path: string): string {
  if (!path || /[\\:\0]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..'))
    fail('file_path', `Expected a safe project-relative file path: ${path}`)
  return path
}

/** Rejects a (realpath-resolved) path outside root. */
export function contained(root: string, path: string): string {
  const location = relative(root, path)
  if (location.split(/[\\/]/).includes('..') || isAbsolute(location))
    fail('file_path', `File must remain inside ${root}`)
  return path
}
