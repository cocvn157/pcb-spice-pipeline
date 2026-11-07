// Was src/stimulus.ts.
import { fail, type SimulationCode } from './diagnostics'

/** Public. Normalizes a transmission pattern to a '0'/'1' string (<= 65536 bits). */
export function transmittedBits(value: unknown, code: SimulationCode = 'stimulus_pattern'): string {
  if ((Array.isArray(value) || typeof value === 'string') && value.length > 65536)
    fail(code, 'Transmission patterns must contain at most 65536 bits')
  if (Array.isArray(value) && value.length && Array.from(value).every(bit => bit === 0 || bit === 1)) return value.join('')
  if (typeof value === 'string' && /^[01]+$/.test(value)) return value
  fail(code, 'A nonempty binary string or array of numeric 0/1 bits is required')
}
