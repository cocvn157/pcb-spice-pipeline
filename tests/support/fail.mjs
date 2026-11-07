// The pre-module error helper (was src/matrices.mjs Diagnostic/fail), kept for the internal test
// helpers in tests/support/ (legacy audit tools, tsx bridge). Same `${code}: ${message}` format.
export class Diagnostic extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.code = code
  }
}
/** @param {string} code @param {string} message @returns {never} */
export function fail(code, message) {
  throw new Diagnostic(code, message)
}
