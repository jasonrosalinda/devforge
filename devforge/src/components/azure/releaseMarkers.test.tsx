import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { snapToStamp, markerLines, releaseTitle, releaseStatus, LastReleaseLabel, SiteReleaseLabel } from './releaseMarkers';

const HOURLY = ['2026-10-20T07:00:00Z', '2026-10-20T08:00:00Z', '2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z'];
const ms = (iso: string) => Date.parse(iso);

describe('snapToStamp', () => {
  it('puts a release in the bucket that holds it, not the nearest one', () => {
    expect(snapToStamp(HOURLY, ms('2026-10-20T09:40:00Z'))).toBe('2026-10-20T09:00:00Z');
    expect(snapToStamp(HOURLY, ms('2026-10-20T09:00:00Z'))).toBe('2026-10-20T09:00:00Z');
  });

  it('keeps a release inside the last bucket and drops one past it', () => {
    expect(snapToStamp(HOURLY, ms('2026-10-20T10:59:00Z'))).toBe('2026-10-20T10:00:00Z');
    expect(snapToStamp(HOURLY, ms('2026-10-20T11:00:00Z'))).toBeNull();
  });

  it('drops a release before the chart starts', () => {
    expect(snapToStamp(HOURLY, ms('2026-10-20T06:59:00Z'))).toBeNull();
  });

  it('uses the smallest gap as the bucket when stamps are missing', () => {
    const gappy = ['2026-10-20T07:00:00Z', '2026-10-20T07:05:00Z', '2026-10-20T08:00:00Z'];
    expect(snapToStamp(gappy, ms('2026-10-20T08:04:00Z'))).toBe('2026-10-20T08:00:00Z');
    expect(snapToStamp(gappy, ms('2026-10-20T08:06:00Z'))).toBeNull();
  });

  it('handles empty, single-stamp and invalid input', () => {
    expect(snapToStamp([], ms('2026-10-20T07:00:00Z'))).toBeNull();
    expect(snapToStamp(['2026-10-20T07:00:00Z'], ms('2026-10-20T07:00:00Z'))).toBe('2026-10-20T07:00:00Z');
    expect(snapToStamp(['2026-10-20T07:00:00Z'], ms('2026-10-20T07:01:00Z'))).toBeNull();
    expect(snapToStamp(HOURLY, NaN)).toBeNull();
  });
});

describe('markerLines', () => {
  it('draws FE and API releases in one bucket as one line naming both, latest per site', () => {
    const lines = markerLines({
      fe: [{ at: '2026-10-20T09:11:56Z', source: 'swap' }, { at: '2026-10-20T09:20:00Z', source: 'swap' }],
      api: [{ at: '2026-10-20T09:11:09Z', source: 'swap' }, { at: '2026-10-19T00:00:00Z', source: 'swap' }],
      hasApi: true,
    }, HOURLY);
    expect(lines).toEqual([{ x: '2026-10-20T09:00:00Z', site: 'fe', label: 'FE 17:20 · API 17:11' }]);
  });

  it('shares the time when FE and API went out in the same minute', () => {
    const [line] = markerLines({
      fe: [{ at: '2026-10-20T09:11:56Z', source: 'swap' }],
      api: [{ at: '2026-10-20T09:11:09Z', source: 'swap' }],
      hasApi: true,
    }, HOURLY);
    expect(line?.label).toBe('FE · API 17:11');
  });

  it('keeps FE and API apart in different buckets', () => {
    const lines = markerLines({
      fe: [{ at: '2026-10-20T07:30:00Z', source: 'swap' }],
      api: [{ at: '2026-10-20T10:05:00Z', source: 'deploy' }],
      hasApi: true,
    }, HOURLY);
    expect(lines).toEqual([
      { x: '2026-10-20T07:00:00Z', site: 'fe', label: 'FE 15:30' },
      { x: '2026-10-20T10:00:00Z', site: 'api', label: 'API 18:05' },
    ]);
  });

  it('says "Release" when the card has no API', () => {
    const [line] = markerLines({ fe: [{ at: '2026-10-20T08:30:00Z', source: 'deploy' }], api: [], hasApi: false }, HOURLY);
    expect(line?.label).toBe('Release 16:30');
  });
});

describe('releaseTitle', () => {
  it('lists time, kind, build, commit, author and message', () => {
    expect(releaseTitle({ at: '2026-10-20T09:11:56Z', source: 'swap', build: '20261015.2', commit: 'b0fa303c', by: 'Rio', message: 'Swap from slot swapslot' }))
      .toBe('2026-10-20 17:11 SGT · slot swap\nBuild 20261015.2\nCommit b0fa303c\nBy Rio\nSwap from slot swapslot');
    expect(releaseTitle({ at: '2026-10-20T09:11:56Z', source: 'revision' })).toBe('2026-10-20 17:11 SGT · new revision');
  });
});

describe('releaseStatus', () => {
  it('shows the last release', () => {
    expect(releaseStatus({ events: [], last: { at: '2026-10-20T09:11:56Z', source: 'deploy' }, sources: { kudu: 'ok' } })?.text)
      .toBe('2026-10-20 17:11 SGT');
  });

  it('separates "no access" from "no release"', () => {
    expect(releaseStatus({ events: [], last: null, sources: { activityLog: 'denied', kudu: 'denied' } })?.text).toBe('n/a');
    expect(releaseStatus({ events: [], last: null, sources: { activityLog: 'denied', kudu: 'ok' } })?.text).toBe('none in 30 days');
  });

  it('says nothing without a result', () => {
    expect(releaseStatus(null)).toBeNull();
  });
});

describe('LastReleaseLabel', () => {
  const swap = { events: [], last: { at: '2026-10-20T09:11:56Z', source: 'swap' as const }, sources: { kudu: 'ok' as const } };
  const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, '');

  it('reads loading while the fetch is in flight', () => {
    expect(html(<LastReleaseLabel loading fe={null} api={null} hasApi />)).toBe('Last release …');
  });

  it('names both sites when the card has an API', () => {
    expect(html(<LastReleaseLabel loading={false} fe={swap} api={{ ...swap, last: null }} hasApi />))
      .toBe('Last release: FE 2026-10-20 17:11 SGT · API none in 30 days');
  });

  it('drops the site name and ignores an API result for a single-site card', () => {
    expect(html(<LastReleaseLabel loading={false} fe={swap} api={swap} hasApi={false} />))
      .toBe('Last release: 2026-10-20 17:11 SGT');
  });

  it('renders nothing when no result came back', () => {
    expect(renderToStaticMarkup(<LastReleaseLabel loading={false} fe={null} api={null} hasApi />)).toBe('');
  });
});

describe('SiteReleaseLabel', () => {
  const swap = { events: [], last: { at: '2026-10-20T09:11:56Z', source: 'swap' as const, build: '20261020.1' }, sources: { kudu: 'ok' as const } };
  const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, '');

  it('reads loading while the fetch is in flight', () => {
    expect(html(<SiteReleaseLabel loading result={null} />)).toBe('Last release …');
  });

  it('shows the site last release in SGT, with the details on hover', () => {
    const markup = renderToStaticMarkup(<SiteReleaseLabel loading={false} result={swap} />);
    expect(markup.replace(/<[^>]+>/g, '')).toBe('Last release 2026-10-20 17:11 SGT');
    expect(markup).toContain('Build 20261020.1');
  });

  it('says when there was no release in the window', () => {
    expect(html(<SiteReleaseLabel loading={false} result={{ ...swap, last: null }} />)).toBe('Last release none in 30 days');
  });

  it('renders nothing without a result', () => {
    expect(renderToStaticMarkup(<SiteReleaseLabel loading={false} result={null} />)).toBe('');
  });
});
