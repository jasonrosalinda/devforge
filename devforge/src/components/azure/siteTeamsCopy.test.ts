import { describe, it, expect } from 'vitest';
import { buildSiteTeamsCopy, instanceColors, snatColors, uptimeColors } from './siteTeamsCopy';

const sections = [
  { section: 'Request', rows: [{ name: 'total', value: '17,307' }, { name: '5xx', value: '1 (<0.1%)', color: '#f00' }] },
  { section: 'Health', rows: [{ name: 'Exceptions', value: '16' }, { name: 'Restarts', value: '0 restarts' }, { name: 'Crashes', value: '0 crashes' }] },
  { section: 'Empty', rows: [] },
];

describe('buildSiteTeamsCopy', () => {
  it('puts the title, chart and every figure in the HTML, escaping values', () => {
    const { html } = buildSiteTeamsCopy({ title: 'Frontend - MEDU', imageUrl: 'data:image/png;base64,AA', sections });
    expect(html).toContain('Frontend - MEDU');
    expect(html).toContain('<img src="data:image/png;base64,AA"');
    expect(html).toContain('1 (&lt;0.1%)');
    expect(html).toContain('color:#f00;');
    expect(html).toContain('Exceptions');
    expect(html).not.toContain('Empty');
  });

  it('leaves the image out when there is none, and keeps the image outside the table', () => {
    expect(buildSiteTeamsCopy({ title: 't', imageUrl: null, sections }).html).not.toContain('<img');
    const { html } = buildSiteTeamsCopy({ title: 't', imageUrl: 'x', sections });
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('<table'));
  });

  it('lays the plain text out as "name | value" under each section', () => {
    const { text } = buildSiteTeamsCopy({ title: 'API', imageUrl: null, sections });
    expect(text).toBe('API\n\nRequest\ntotal | 17,307\n5xx | 1 (<0.1%)\n\nHealth\nExceptions | 16\nRestarts | 0 restarts\nCrashes | 0 crashes');
  });
});

describe('status row colours', () => {
  const RED = '#f85149', ORANGE = '#f97316', GREEN = '#2ea043';

  it('instances: red when none run or all are stopped, else plain', () => {
    expect(instanceColors(2, 0, 2)).toEqual([undefined, undefined, undefined]);
    expect(instanceColors(0, 2, 2)).toEqual([RED, RED, undefined]);
    expect(instanceColors(1, 1, 2)).toEqual([undefined, undefined, undefined]);
  });

  it('SNAT: pending orange, failed red, nothing for zero or no data', () => {
    expect(snatColors(0, 0)).toEqual([undefined, undefined, undefined]);
    expect(snatColors(3, 1)).toEqual([ORANGE, RED, undefined]);
    expect(snatColors(null, null)).toEqual([undefined, undefined, undefined]);
  });

  it('UptimeRobot: incidents red, a full 100% green', () => {
    expect(uptimeColors(0, 100)).toEqual([undefined, undefined, GREEN]);
    expect(uptimeColors(2, 99.5)).toEqual([undefined, RED, undefined]);
    expect(uptimeColors(0, null)).toEqual([undefined, undefined, undefined]);
  });
});
