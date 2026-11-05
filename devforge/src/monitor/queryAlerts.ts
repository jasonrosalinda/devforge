import type { TelemetryResult } from '@shared/types/telemetry.types';
import type { TelemetryAlertRule } from '@/lib/telemetry-library';

export interface QueryOutcome {
  firing: boolean;
  /** What the rule measured: the row count, or the column's largest value. */
  value: number | null;
  /** The rule can't be evaluated against this result (e.g. its column is gone). */
  error?: string;
}

/** Whether a rule is due: never run, or `everyMin` since the last run. */
export function isDue(rule: TelemetryAlertRule, lastRunMs: number | undefined, nowMs: number): boolean {
  return lastRunMs == null || nowMs - lastRunMs >= rule.everyMin * 60_000 - 1_000; // 1s slack for tick jitter
}

/** Evaluate one rule against one query result. Pure; exported for tests. */
export function evaluateQueryRule(rule: TelemetryAlertRule, result: TelemetryResult | undefined): QueryOutcome {
  const rows = result?.rows ?? [];
  if (rule.kind === 'rows') return { firing: rows.length > 0, value: rows.length };

  const idx = (result?.columns ?? []).findIndex(c => c.name === rule.column);
  if (idx < 0) return { firing: false, value: null, error: `Column "${rule.column ?? ''}" is not in the result` };
  let max: number | null = null;
  for (const row of rows) {
    const cell = row[idx];
    // Number(null) and Number('') are 0 — an empty cell is no reading, not a zero.
    if (cell == null || cell === '') continue;
    const v = typeof cell === 'number' ? cell : Number(cell);
    if (Number.isFinite(v) && (max == null || v > max)) max = v;
  }
  return { firing: max != null && max > (rule.threshold ?? 0), value: max };
}

/** Alert once when a rule starts firing; it re-arms when the condition clears. An unknown
 *  previous state counts as not firing, so a rule already true when switched on alerts once. */
export const shouldAlert = (wasFiring: boolean | undefined, outcome: QueryOutcome): boolean =>
  outcome.firing && !wasFiring;

export function queryAlertBody(name: string, rule: TelemetryAlertRule, outcome: QueryOutcome, truncated = false): string {
  const window = `last ${rule.windowMin} min`;
  if (rule.kind === 'rows') return `"${name}" returned ${outcome.value}${truncated ? '+' : ''} ${outcome.value === 1 ? 'row' : 'rows'} (${window})`;
  return `"${name}": ${rule.column} reached ${outcome.value} (above ${rule.threshold ?? 0}, ${window})`;
}
