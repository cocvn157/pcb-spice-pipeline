import { readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { IbisSources } from '../buffers/index.js'
import type { CircuitJson } from '../board/index.js'
import { contained, relativeFile } from './paths.js'

/** Load declared local files only. Asset URLs do not trigger downloads. Realpath-contained in baseDir. */
export async function loadIbisSources({ circuitJson, baseDir }: { circuitJson: CircuitJson; baseDir: string }): Promise<IbisSources> {
  const root = await realpath(baseDir), sources: IbisSources = Object.create(null)
  for (const record of circuitJson) if (record.type === 'simulation_ibis_model') {
    const path = relativeFile(record.ibis_model_asset.project_relative_path)
    if (!Object.hasOwn(sources, path)) sources[path] = await readFile(contained(root, await realpath(resolve(root, path))))
  }
  return sources
}
