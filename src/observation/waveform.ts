import { fail } from './diagnostics.js'

// General measurements consume recorded probe values, never an assumed bit pattern.
/** Parse ngspice wrdata text (header line, then time + one column per probe). Was metrics.mjs probeWaveformRows. */
export function probeWaveformRows(text: string, probes: readonly unknown[]): number[][] {
  const rows = text.trim().split(/\r?\n/).slice(1).map(line => line.trim().split(/\s+/).map(Number))
  if (!rows.length || rows.some(row => row.length !== probes.length + 1 || row.some(value => !Number.isFinite(value))))
    fail('waveform', 'Expected actual time and one finite column per declared probe')
  if (rows.some((row, i) => i > 0 && row[0] <= rows[i - 1][0])) fail('waveform', 'Actual solver timestamps must strictly increase')
  return rows
}
