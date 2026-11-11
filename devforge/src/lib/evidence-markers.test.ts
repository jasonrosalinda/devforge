import { describe, it, expect } from 'vitest';
import { circled, numberEvidence, withEvidenceImages } from './evidence-markers';

describe('withEvidenceImages', () => {
  const images = [
    { src: 'data:image/png;base64,AAA', alt: 'Incident timeline' },
    { src: 'data:image/png;base64,BBB', alt: 'Frontend [requests]' },
  ];
  it('places one picture per chart right under the Evidences heading, after the caption', () => {
    expect(withEvidenceImages('## Summary\nx\n\n## Evidences\n- a', images, ' 1-minute buckets '))
      .toBe('## Summary\nx\n\n## Evidences\n\n_1-minute buckets_\n\n![Incident timeline](data:image/png;base64,AAA)\n\n![Frontend  requests ](data:image/png;base64,BBB)\n\n- a');
  });
  it('leaves the report alone with no pictures or no Evidences heading', () => {
    expect(withEvidenceImages('## Evidences\n- a', [], 'caption')).toBe('## Evidences\n- a');
    expect(withEvidenceImages('## Summary\nx', images)).toBe('## Summary\nx');
  });
});

const window = { startMs: Date.parse('2026-11-10T09:00:00Z'), endMs: Date.parse('2026-11-10T13:00:00Z') }; // 17:00–21:00 SGT
const report = [
  '## Summary', 'Down at 20:15.', '',
  '## Evidences',
  '- **20:00–20:15 SGT · API:** 5xx burst, peak 13.6%.',
  '- **Frontend:** CPU averaged 5.4%.',
  '- 20:21 SGT: three Kudu kills.',
  '- **23:30 SGT · API:** outside the window.',
  '', '## Code Suspects', '- 20:00 SGT is not evidence here.',
].join('\n');

describe('numberEvidence', () => {
  it('numbers the timed Evidences bullets and returns a marker for each', () => {
    const out = numberEvidence(report, window);
    expect(out.markers).toEqual([
      { n: 1, atMs: Date.parse('2026-11-10T12:00:00Z'), endMs: Date.parse('2026-11-10T12:15:00Z'), label: 'API: 5xx burst, peak 13.6%.' },
      { n: 2, atMs: Date.parse('2026-11-10T12:21:00Z'), label: 'three Kudu kills.' },
    ]);
    expect(out.markdown).toContain('- ① **20:00–20:15 SGT · API:** 5xx burst');
    expect(out.markdown).toContain('- **Frontend:** CPU averaged 5.4%.');
    expect(out.markdown).toContain('- ② 20:21 SGT: three Kudu kills.');
    expect(out.markdown).toContain('- **23:30 SGT · API:** outside the window.');
    // Other sections are left alone.
    expect(out.markdown).toContain('## Code Suspects\n- 20:00 SGT is not evidence here.');
  });

  it('places a time on the right day when the window crosses midnight, and reads the old heading', () => {
    const w = { startMs: Date.parse('2026-11-10T14:00:00Z'), endMs: Date.parse('2026-11-10T18:00:00Z') }; // 22:00–02:00 SGT
    const out = numberEvidence('## Azure Evidence\n- **00:05 SGT · DB:** CPU 78%.', w);
    expect(out.markers[0]!.atMs).toBe(Date.parse('2026-11-10T16:05:00Z'));
  });

  it('leaves a report without an Evidences section unchanged', () => {
    expect(numberEvidence('## Summary\nx', window)).toEqual({ markdown: '## Summary\nx', markers: [] });
    expect(circled(3)).toBe('③');
    expect(circled(21)).toBe('(21)');
  });
});
