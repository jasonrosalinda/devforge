import type { AppMetrics } from '@shared/types/azureMetrics.types';

export type Status = 'healthy' | 'warning' | 'critical';

export function getStatus(cpuAvg: number, memAvg: number, cpuP99?: number, memP99?: number): Status {
  if (cpuAvg > 90 || memAvg > 95 || (cpuP99 ?? 0) >= 100 || (memP99 ?? 0) >= 100) return 'critical';
  if (cpuAvg > 70 || memAvg > 80  || (cpuP99 ?? 0) > 85  || (memP99 ?? 0) > 90)  return 'warning';
  return 'healthy';
}

/** The card's overall status. Memory in MB has no capacity to be a percentage of, so
 *  it does not count. Kept free of React so the background monitor can import it. */
export function cardStatus(m: AppMetrics): Status {
  const memPct = m.memUnit === 'MB' ? 0 : m.memory.avg;
  const memP99Pct = m.memUnit === 'MB' ? 0 : m.memory.p99;
  return getStatus(m.cpu.avg, memPct, m.cpu.p99, memP99Pct);
}
