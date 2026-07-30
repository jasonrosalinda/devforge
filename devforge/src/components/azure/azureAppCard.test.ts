import { describe, it, expect } from 'vitest';
import { getStatus, timeoutLayer, fmtDuration } from './azureAppCard';

describe('getStatus', () => {
  it('returns critical when cpu > 90', () => {
    expect(getStatus(91, 50)).toBe('critical');
  });
  it('returns critical when mem > 95', () => {
    expect(getStatus(50, 96)).toBe('critical');
  });
  it('returns warning when cpu > 70', () => {
    expect(getStatus(71, 50)).toBe('warning');
  });
  it('returns warning when mem > 80', () => {
    expect(getStatus(50, 81)).toBe('warning');
  });
  it('returns healthy otherwise', () => {
    expect(getStatus(50, 50)).toBe('healthy');
  });
  it('critical takes priority over warning', () => {
    expect(getStatus(91, 81)).toBe('critical');
  });
});

// Every duration on the card goes through fmtDuration, so the unit boundaries are
// worth pinning. Values below are real ones observed in the telemetry.
describe('fmtDuration', () => {
  it('keeps sub-second values in ms', () => {
    expect(fmtDuration(38)).toBe('38ms');
    expect(fmtDuration(387)).toBe('387ms');
    expect(fmtDuration(999)).toBe('999ms');
  });
  it('switches to seconds at 1000ms', () => {
    expect(fmtDuration(1000)).toBe('1s');
    expect(fmtDuration(1160)).toBe('1.2s');   // was "1160ms"
    expect(fmtDuration(2640)).toBe('2.6s');   // was "2,640ms"
    expect(fmtDuration(19464)).toBe('19.5s'); // was "19464ms"
    expect(fmtDuration(30393)).toBe('30.4s'); // SQL command timeout
  });
  it('switches to minutes at 60s', () => {
    expect(fmtDuration(60000)).toBe('1m');
    expect(fmtDuration(147515)).toBe('2.5m');   // Cloudflare 524 p95
    expect(fmtDuration(179548)).toBe('3m');
    expect(fmtDuration(2128617)).toBe('35.5m'); // worst observed 524
  });
  it('switches to hours at 60m, then days at 24h', () => {
    expect(fmtDuration(3600000)).toBe('1h');
    expect(fmtDuration(5400000)).toBe('1.5h');
    expect(fmtDuration(86400000)).toBe('1d');
    expect(fmtDuration(90000000)).toBe('1d');   // 25h
  });
  it('trims a trailing .0 so whole values are clean', () => {
    expect(fmtDuration(5000)).toBe('5s');
    expect(fmtDuration(300000)).toBe('5m');
  });
  it('renders missing or negative input as an em dash', () => {
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(undefined)).toBe('—');
    expect(fmtDuration(NaN)).toBe('—');
    expect(fmtDuration(-1)).toBe('—');
  });
});

// Exception types below are verbatim from live App Insights telemetry. The Timeout
// tab heading is derived from these, so a mis-map renames the section.
describe('timeoutLayer', () => {
  it('maps a SQL command timeout', () => {
    // SqlClient surfaces a command timeout as Win32Exception on Linux.
    expect(timeoutLayer('System.ComponentModel.Win32Exception')).toMatchObject({ layer: 'SQL', heading: 'SQL command timeouts' });
    expect(timeoutLayer('Microsoft.Data.SqlClient.SqlException').layer).toBe('SQL');
  });
  it('maps an HttpClient deadline', () => {
    expect(timeoutLayer('System.Threading.Tasks.TaskCanceledException')).toMatchObject({ layer: 'HTTP', heading: 'HTTP client timeouts' });
    expect(timeoutLayer('System.Net.Http.HttpRequestException').layer).toBe('HTTP');
  });
  it('prefers Redis over the generic TimeoutException rule', () => {
    // RedisTimeoutException matches both; the Redis branch must win or the
    // heading and the fix hint both point at the wrong layer.
    expect(timeoutLayer('StackExchange.Redis.RedisTimeoutException')).toMatchObject({ layer: 'Redis', heading: 'Redis timeouts' });
    expect(timeoutLayer('StackExchange.Redis.RedisConnectionException').layer).toBe('Redis');
  });
  it('separates a plain cancellation from an HttpClient deadline', () => {
    expect(timeoutLayer('System.OperationCanceledException')).toMatchObject({ layer: 'Cancel', heading: 'Cancelled operations' });
  });
  it('falls back to the neutral heading for an explicit or unknown timeout', () => {
    expect(timeoutLayer('System.TimeoutException')).toMatchObject({ layer: 'App', heading: 'Application timeouts' });
    expect(timeoutLayer('Some.Unrecognised.Exception')).toMatchObject({ layer: '—', heading: 'Application timeouts', hint: '' });
  });
  it('gives every recognised layer a fix hint', () => {
    for (const t of ['System.ComponentModel.Win32Exception', 'StackExchange.Redis.RedisTimeoutException',
                     'System.Threading.Tasks.TaskCanceledException', 'System.OperationCanceledException',
                     'System.TimeoutException']) {
      expect(timeoutLayer(t).hint.length).toBeGreaterThan(0);
    }
  });
});
