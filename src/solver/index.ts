/**
 * solver — the one port to native execution, and the protocol for using it.
 * Owns: SolverRequest/SolverResult/RunSolver (public), result validation
 * (shape, exit code, required outputs), and capture of request/stdout/stderr/files as artifacts.
 * Does NOT own: interpreting solver output (extraction, simulation do that).
 * Imports: kernel.
 */
import { diagnostics, type ArtifactScope, type Produced } from '../kernel/index.js'

export type Solver = 'fasthenry' | 'fastercap' | 'ngspice'
export interface SolverRequest {
  solver: Solver
  /** Paths relative to the solver's isolated working directory. */
  files: Record<string, string>
  args: string[]
  outputFiles: string[]
}
export interface SolverResult { stdout: string; stderr: string; files: Record<string, string>; exitCode?: number }
/** Reject on an unsuccessful exit. The library also validates diagnostics and outputs. */
export type RunSolver = (request: SolverRequest) => Promise<SolverResult>

/** What a solver-spending operation is handed. Only post-validation pipeline stages can build one. */
export interface SolverContext {
  readonly runSolver: RunSolver
  readonly progress: (message: string) => void
}

/** A result that passed the protocol checks: required outputs are present strings, exit was 0. */
export interface AcceptedRun<O extends string = string> {
  readonly stdout: string
  readonly stderr: string
  readonly outputs: Readonly<Record<O, string>>
  /** Every input and output file (supplied files overlaid by solver files), as today's executeSolver recorded them. */
  readonly files: Readonly<Record<string, string>>
  /** Where the logs live, for diagnostics raised by the interpreting module. */
  readonly logPaths: readonly string[]
}

const fail = diagnostics('solver', ['solver_result', 'native_solver', 'native_output'] as const)

/**
 * The only way any module runs a solver. Copies the request (callee can't mutate ours),
 * validates the result, and returns the accepted run plus artifacts under `scope`:
 *   <scope>/<input files>, <scope>/<outputs>, <solver>.stdout.log, <solver>.stderr.log, <solver>.request.json
 * On rejection it throws before recording anything, exactly like the pre-module executeSolver.
 */
export async function invoke<const O extends string>(
  ctx: SolverContext,
  scope: ArtifactScope,
  request: SolverRequest & { outputFiles: readonly O[] },
): Promise<Produced<AcceptedRun<O>>> {
  const supplied = { ...request.files }
  const result = await ctx.runSolver({ ...request, files: { ...supplied }, args: [...request.args], outputFiles: [...request.outputFiles] })
  if (!result || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || !result.files || typeof result.files !== 'object')
    fail('solver_result', `${request.solver}: expected stdout, stderr and files`)
  if (result.exitCode !== undefined && result.exitCode !== 0)
    fail('native_solver', `${request.solver}: exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`)
  for (const file of request.outputFiles) if (!Object.hasOwn(result.files, file) || typeof result.files[file] !== 'string')
    fail('native_output', `${request.solver}: missing ${file}`)
  const merged: Record<string, string> = { ...supplied, ...result.files }
  const artifacts = []
  for (const [path, body] of Object.entries(merged)) {
    if (typeof body !== 'string') fail('solver_result', `${request.solver}: ${path} must be a string`)
    artifacts.push(scope.text(path, body))
  }
  const logs = [scope.text(`${request.solver}.stdout.log`, result.stdout), scope.text(`${request.solver}.stderr.log`, result.stderr)]
  artifacts.push(...logs, scope.json(`${request.solver}.request.json`, request))
  const outputs = Object.fromEntries(request.outputFiles.map(file => [file, result.files[file]])) as Record<O, string>
  return { value: { stdout: result.stdout, stderr: result.stderr, outputs, files: merged, logPaths: logs.map(a => a.path) }, artifacts }
}
