import { describe, expect, it } from 'vitest';
import { breakableUrlLink, breakableUrlText, teamsTableHtml, teamsTableText } from './teams-html';

const ZWSP = '\u200B';

describe('breakableUrlText', () => {
    it('adds a wrap point after each URL separator without changing the visible text', () => {
        const url = 'https://www.example.com/singapore/news-updates/topic?id=1&x_y=2';
        const text = breakableUrlText(url);
        expect(text.replaceAll(ZWSP, '')).toBe(url);
        expect(text).toContain(`/${ZWSP}singapore`);
        expect(text).toContain(`-${ZWSP}updates`);
        expect(text).toContain(`?${ZWSP}id`);
        expect(text).toContain(`&${ZWSP}x_${ZWSP}y`);
    });
});

describe('breakableUrlLink', () => {
    it('keeps the exact URL in the href and the wrappable text in the link', () => {
        const html = breakableUrlLink('https://example.com/a-b');
        expect(html).toBe(`<a href="https://example.com/a-b">https:/${ZWSP}/${ZWSP}example.${ZWSP}com/${ZWSP}a-${ZWSP}b</a>`);
    });

    it('shows a shorter label (the page path) while linking to the full URL', () => {
        expect(breakableUrlLink('https://example.com/a-b', '/a-b')).toBe(`<a href="https://example.com/a-b">/${ZWSP}a-${ZWSP}b</a>`);
    });

    it('escapes HTML in both the href and the text', () => {
        const html = breakableUrlLink('https://example.com/?q="<x>"&y=1');
        expect(html).not.toContain('<x>');
        expect(html).toContain('href="https://example.com/?q=&quot;&lt;x&gt;&quot;&amp;y=1"');
    });
});

describe('teamsTableHtml / teamsTableText', () => {
    const table = {
        title: 'Release <b>verdict</b>',
        subtitle: '2026-11-05 14:00 SGT',
        headers: ['Metric', 'Before', 'After'],
        rows: [['5xx rate', '0.1%', '<script>x</script>']],
        footer: ['New: System.Timeout & co'],
    };

    it('escapes every value and inlines the styles Teams keeps', () => {
        const html = teamsTableHtml(table);
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
        expect(html).toContain('Release &lt;b&gt;verdict&lt;/b&gt;');
        expect(html).toContain('System.Timeout &amp; co');
        expect(html).toMatch(/<td style="[^"]+">5xx rate<\/td>/);
        expect(html).not.toContain('class=');
    });

    it('omits the subtitle and footer when absent', () => {
        const html = teamsTableHtml({ title: 't', headers: ['a'], rows: [] });
        expect(html).not.toContain('font-size:11px');
        expect(teamsTableText({ title: 't', headers: ['a'], rows: [['1']] })).toBe('t\n\na\n1');
    });

    it('writes a pipe-separated plain-text fallback', () => {
        expect(teamsTableText(table)).toBe(
            'Release <b>verdict</b>\n2026-11-05 14:00 SGT\n\nMetric | Before | After\n5xx rate | 0.1% | <script>x</script>\n\nNew: System.Timeout & co',
        );
    });
});
