import { describe, it, expect } from 'vitest';
import { diffLines } from './textDiff';

const shape = (left: string, right: string, options?: Parameters<typeof diffLines>[2]) =>
    diffLines(left, right, options).rows.map((row) => `${row.type}:${row.text}`);

describe('diffLines', () => {
    it('marks every line unchanged for identical input', () => {
        const result = diffLines('a\nb\nc', 'a\nb\nc');

        expect(result.rows.every((row) => row.type === 'same')).toBe(true);
        expect(result.stats).toEqual({ added: 0, removed: 0, unchanged: 3 });
    });

    it('reports pure additions', () => {
        expect(shape('a\nb', 'a\nb\nc')).toEqual(['same:a', 'same:b', 'add:c']);
    });

    it('reports pure deletions', () => {
        expect(shape('a\nb\nc', 'a\nc')).toEqual(['same:a', 'del:b', 'same:c']);
    });

    it('pairs a replaced line as a deletion followed by an addition', () => {
        expect(shape('a\nb\nc', 'a\nx\nc')).toEqual(['same:a', 'del:b', 'add:x', 'same:c']);
    });

    it('handles interleaved edits across the file', () => {
        expect(shape('one\ntwo\nthree\nfour', 'one\ntwo-b\nthree\nfive\nfour')).toEqual([
            'same:one',
            'del:two',
            'add:two-b',
            'same:three',
            'add:five',
            'same:four',
        ]);
    });

    it('numbers the left and right sides independently', () => {
        const rows = diffLines('a\nb\nc', 'a\nc').rows;

        expect(rows.map((row) => [row.type, row.leftLine, row.rightLine])).toEqual([
            ['same', 1, 1],
            ['del', 2, null],
            ['same', 3, 2],
        ]);
    });

    it('counts additions and deletions', () => {
        expect(diffLines('a\nb\nc', 'a\nx\ny').stats).toEqual({ added: 2, removed: 2, unchanged: 1 });
    });

    it('treats an empty side as a whole-file addition', () => {
        expect(shape('', 'a\nb')).toEqual(['add:a', 'add:b']);
    });

    describe('ignoreWhitespace', () => {
        it('treats lines differing only in spacing as unchanged', () => {
            expect(shape('  foo   bar  ', 'foo bar', { ignoreWhitespace: true })).toEqual(['same:  foo   bar  ']);
        });

        it('still reports them as changed when the option is off', () => {
            expect(shape('  foo   bar  ', 'foo bar')).toEqual(['del:  foo   bar  ', 'add:foo bar']);
        });
    });

    describe('ignoreCase', () => {
        it('treats lines differing only in case as unchanged', () => {
            expect(shape('Foo\nBAR', 'foo\nbar', { ignoreCase: true })).toEqual(['same:Foo', 'same:BAR']);
        });

        it('still reports them as changed when the option is off', () => {
            expect(shape('Foo', 'foo')).toEqual(['del:Foo', 'add:foo']);
        });
    });

    // The comparison is quadratic in the worst case, so oversized input is cut
    // and flagged rather than left to lock up the window.
    it('truncates input beyond the line limit and says so', () => {
        const big = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');

        const result = diffLines(big, big, { maxLines: 50 });

        expect(result.truncated).toBe(true);
        expect(result.rows).toHaveLength(50);
    });

    it('does not flag truncation for input within the limit', () => {
        expect(diffLines('a\nb', 'a\nb', { maxLines: 50 }).truncated).toBe(false);
    });
});
