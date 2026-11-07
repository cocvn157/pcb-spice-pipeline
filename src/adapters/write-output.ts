import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { PipelineResult } from '../pipeline'
import { generateReport } from '../report'
import { contained, relativeFile } from './paths'

/** Write the supplied result and a report at the caller's explicit request. */
export async function writePipelineOutput({ result, outputDir }: { result: PipelineResult; outputDir: string }): Promise<void> {
  const files = { ...result.files, ...generateReport(result) }
  for (const path of Object.keys(files)) relativeFile(path)
  await mkdir(outputDir, { recursive: true })
  const root = await realpath(outputDir)
  for (const [path, body] of Object.entries(files)) {
    const target = resolve(root, path)
    await mkdir(dirname(target), { recursive: true })
    contained(root, await realpath(dirname(target)))
    try {
      contained(root, await realpath(target))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await writeFile(target, body)
  }
}
