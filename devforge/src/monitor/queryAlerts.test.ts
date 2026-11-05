import { describe, it, expect } from 'vitest';
import { evaluateQueryRule, isDue, queryAlertBody, shouldAlert } from './queryAlerts';
import { DEFAULT_ALERT_RULE, type TelemetryAlertRule } from '@/lib/telemetry-library';

const rows: TelemetryAlertRule = DEFAULT_ALERT_RULE;
const column: TelemetryAlertRule = { ...DEFAULT_ALERT_RULE, kind: 'column', column: 'p95', threshold: 2000 };
const result = (values: unknown[]) => ({
  columns: [{ name: 'name', type: 'string' }, { name: 'p95', type: 'real' }],
  rows: values.map(v => ['GET /', v]) as never,
});

describe('evaluateQueryRule', () => {
  it('rows: fires on any row', () => {
    expect(evaluateQueryRule(rows, { rows: [] })).toEqual({ firing: false, value: 0 });
    expect(evaluateQueryRule(rows, { rows: [['x'], ['y']] })).toEqual({ firing: true, value: 2 });
    expect(evaluateQueryRule(rows, undefined)).toEqual({ firing: false, value: 0 });
  });

  it('column: fires when the largest value is above the threshold, not equal to it', () => {
    expect(evaluateQueryRule(column, result([1500, 2500]))).toEqual({ firing: true, value: 2500 });
    expect(evaluateQueryRule(column, result([2000]))).toEqual({ firing: false, value: 2000 });
  });

  it('column: reads numeric strings and skips non-numbers', () => {
    expect(evaluateQueryRule(column, result(['3000', null, 'n/a']))).toEqual({ firing: true, value: 3000 });
    expect(evaluateQueryRule(column, result([null]))).toEqual({ firing: false, value: null });
  });

  it('column: reports a missing column instead of silently never firing', () => {
    const out = evaluateQueryRule({ ...column, column: 'gone' }, result([9999]));
    expect(out).toMatchObject({ firing: false, error: 'Column "gone" is not in the result' });
  });
});

describe('shouldAlert', () => {
  it('alerts on the transition into firing only, and re-arms after it clears', () => {
    const on = { firing: true, value: 1 };
    const off = { firing: false, value: 0 };
    expect(shouldAlert(undefined, on)).toBe(true);
    expect(shouldAlert(true, on)).toBe(false);
    expect(shouldAlert(true, off)).toBe(false);
    expect(shouldAlert(false, on)).toBe(true);
  });
});

describe('isDue', () => {
  it('runs a rule first time, then every everyMin minutes, tolerating a little tick jitter', () => {
    const now = 1_000_000_000;
    expect(isDue(rows, undefined, now)).toBe(true);
    expect(isDue(rows, now - 4 * 60_000, now)).toBe(false);
    expect(isDue(rows, now - 5 * 60_000 + 500, now)).toBe(true);
  });
});

describe('queryAlertBody', () => {
  it('describes the measurement and window', () => {
    expect(queryAlertBody('Failed deps', rows, { firing: true, value: 12 })).toBe('"Failed deps" returned 12 rows (last 15 min)');
    expect(queryAlertBody('Failed deps', rows, { firing: true, value: 1 })).toBe('"Failed deps" returned 1 row (last 15 min)');
    expect(queryAlertBody('Big', rows, { firing: true, value: 5000 }, true)).toBe('"Big" returned 5000+ rows (last 15 min)');
    expect(queryAlertBody('Slow', column, { firing: true, value: 2500 })).toBe('"Slow": p95 reached 2500 (above 2000, last 15 min)');
  });
});
