import { describe, expect, it } from 'vitest';
import { breakableUrlLink, breakableUrlText } from './teams-html';

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
