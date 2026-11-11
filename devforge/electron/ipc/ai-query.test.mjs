import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { withoutLoadTest } = require('./ai-query.cjs');

describe('withoutLoadTest', () => {
  it('shadows every App Insights table with a copy that drops load-test roles, then runs the query', () => {
    const q = withoutLoadTest('requests | summarize count() by cloud_RoleName');
    for (const t of ['requests', 'dependencies', 'exceptions', 'traces', 'pageViews', 'customMetrics', 'performanceCounters']) {
      expect(q).toContain(`let ${t} = ${t} | where cloud_RoleName !endswith '-loadtest';`);
    }
    expect(q.endsWith('\nrequests | summarize count() by cloud_RoleName')).toBe(true);
  });
});
