import { diagnostics } from './diagnostic'
/** Kernel's own failer; not exported from kernel/index.ts. */
export const fail = diagnostics('kernel', ['artifact_collision', 'artifact_path', 'simulation_id'] as const)
