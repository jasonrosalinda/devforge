/**
 * Instance status for the Instances summary row and Copy for Teams, kept in one
 * place so the two can never count a different split.
 */

export type InstanceState = 'running' | 'stopped';

export interface InstanceLike {
  name: string;
  /** Still serving traffic at the end of the window. */
  stillActive: boolean;
  /** Present only when the instance has a series; without one "stillActive" means nothing. */
  lifecycle: string | null;
  /** ARM health status ("Healthy", "Degraded", "Stopped", …). */
  healthStatus: string;
}

/**
 * Stopped = ARM says so, or the instance stopped reporting before the window ended
 * (the "stopped" tag the expanded legend shows). Everything else is running,
 * whatever its health — the health % is in the hover and the expanded chart.
 */
export function classifyInstance(inst: InstanceLike): InstanceState {
  if (inst.healthStatus.toLowerCase() === 'stopped') return 'stopped';
  if (inst.lifecycle && !inst.stillActive) return 'stopped';
  return 'running';
}

export interface InstanceSummary<T extends InstanceLike> {
  running: T[];
  stopped: T[];
  total: number;
}

export function summarizeInstances<T extends InstanceLike>(instances: T[]): InstanceSummary<T> {
  const summary: InstanceSummary<T> = { running: [], stopped: [], total: instances.length };
  for (const inst of instances) summary[classifyInstance(inst)].push(inst);
  return summary;
}
