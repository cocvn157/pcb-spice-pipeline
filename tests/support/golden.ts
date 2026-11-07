// Committed-snapshot oracle for the golden tests. The digests were recorded on 2026-11-07 while the
// pre-module flat src/ still existed and the old-vs-new golden comparisons passed, so each digest is
// the digest of the pre-module implementation's outputs. Regenerate only deliberately with
// UPDATE_SNAPSHOTS=1 (a changed digest is a behaviour change, not a snapshot to refresh).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

/** Order-preserving serialization that keeps what JSON drops: undefined, NaN, ±Infinity, -0, Uint8Array. */
export function serialize(value: unknown): string {
  return JSON.stringify(value, function (key, v) {
    const raw = key === '' ? v : (this as Record<string, unknown>)[key]
    if (raw === undefined) return { $: 'undefined' }
    if (typeof raw === 'number' && (!Number.isFinite(raw) || Object.is(raw, -0))) return { $: Object.is(raw, -0) ? '-0' : String(raw) }
    if (raw instanceof Uint8Array) return { $bytes: Buffer.from(raw).toString('base64') }
    if (raw instanceof Map) return { $map: [...raw.entries()] }
    return v
  })
}

export type See = (label: string, value: unknown) => void

/** One digest per named check over every (label, value) the body sees, compared with `file`. */
export function goldenDigests(file: URL): (name: string, body: (see: See) => void | Promise<void>) => Promise<void> {
  const update = process.env.UPDATE_SNAPSHOTS === '1'
  let stored: Record<string, string> = {}
  try {
    stored = JSON.parse(readFileSync(file, 'utf8'))
  } catch { /* recorded on first UPDATE_SNAPSHOTS=1 run */ }
  const next: Record<string, string> = {}
  if (update) test.after(() => writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(next).sort()), null, 2) + '\n'))
  return async function check(name: string, body: (see: See) => void | Promise<void>): Promise<void> {
    const hash = createHash('sha256')
    let count = 0
    await body((label, value) => {
      hash.update(label + '\0' + serialize(value) + '\0')
      count++
    })
    const digest = `${count}:${hash.digest('hex')}`
    next[name] = digest
    if (!update) assert.equal(digest, stored[name], `${name}: outputs differ from the committed pre-module snapshot`)
  }
}

/** Value or error (code + message) of a call, for comparing failures. */
export function outcome(f: () => unknown): { value: string } | { code?: string; message: string } {
  try {
    return { value: serialize(f()) }
  } catch (e) {
    return { code: (e as { code?: string }).code, message: (e as Error).message }
  }
}
/** Async form of outcome: awaits the call and captures its value or rejection the same way. */
export async function outcomeAsync(f: () => Promise<unknown>): Promise<{ value: string } | { code?: string; message: string }> {
  try {
    return { value: serialize(await f()) }
  } catch (e) {
    return { code: (e as { code?: string }).code, message: (e as Error).message }
  }
}
