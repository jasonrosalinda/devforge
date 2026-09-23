import { describe, it, expect } from 'vitest';
import { lintDotNetDifferences, runRegex } from './regexLint';

const constructs = (pattern: string) => lintDotNetDifferences(pattern).map((w) => w.construct);

describe('lintDotNetDifferences', () => {
    it('returns nothing for a pattern both engines treat the same way', () => {
        expect(lintDotNetDifferences('^(?<id>\\d{3})-[A-Z]+$')).toEqual([]);
    });

    it.each([
        ['balancing group', '(?<close-open>.*)', 'balancing-group'],
        ['conditional', '(?(open)yes|no)', 'conditional'],
        ['inline options', '(?i)abc', 'inline-options'],
        ['scoped inline options', '(?im:abc)', 'inline-options'],
        ['atomic group', '(?>a+)b', 'atomic-group'],
        ['end-of-string anchor', 'abc\\Z', 'end-anchor'],
        ['unicode category', '\\p{IsGreek}', 'unicode-category'],
        ['inline comment', 'a(?#skip me)b', 'inline-comment'],
    ])('flags a %s', (_label, pattern, construct) => {
        expect(constructs(pattern)).toEqual([construct]);
    });

    it('reports a construct once however often it appears', () => {
        expect(constructs('(?>a)(?>b)(?>c)')).toEqual(['atomic-group']);
    });

    it('reports every distinct construct in one pattern', () => {
        expect(constructs('(?i)(?>a)\\Z').sort()).toEqual(['atomic-group', 'end-anchor', 'inline-options']);
    });

    it('explains each warning in prose', () => {
        const [warning] = lintDotNetDifferences('(?>a+)');

        expect(warning?.message.length).toBeGreaterThan(20);
    });

    it('does not mistake a non-capturing group or lookaround for inline options', () => {
        expect(lintDotNetDifferences('(?:a)(?=b)(?!c)(?<=d)(?<!e)')).toEqual([]);
    });
});

describe('runRegex', () => {
    it('returns every match with its position when the global flag is set', () => {
        const result = runRegex('\\d+', 'g', 'a1 bb22 c333');

        expect(result.error).toBeNull();
        expect(result.matches.map((m) => [m.text, m.index])).toEqual([['1', 1], ['22', 5], ['333', 9]]);
    });

    it('returns only the first match without the global flag', () => {
        expect(runRegex('\\d+', '', 'a1 bb22').matches).toHaveLength(1);
    });

    it('exposes numbered and named capture groups', () => {
        const [match] = runRegex('(?<year>\\d{4})-(\\d{2})', '', '2026-09').matches;

        expect(match?.groups).toEqual([
            { name: 'year', value: '2026' },
            { name: '2', value: '09' },
        ]);
    });

    // Naming groups by matching their captured text falls apart the moment two
    // groups capture the same string, so the name has to come from the pattern.
    it('names groups by position when several capture identical text', () => {
        const [match] = runRegex('(?<first>x)(x)(?<third>x)', '', 'xxx').matches;

        expect(match?.groups).toEqual([
            { name: 'first', value: 'x' },
            { name: '2', value: 'x' },
            { name: 'third', value: 'x' },
        ]);
    });

    it('ignores group-like text inside a character class', () => {
        const [match] = runRegex('[(?<a>]+(b)', '', '(?<a>b').matches;

        expect(match?.groups).toEqual([{ name: '1', value: 'b' }]);
    });

    it('reports a group that did not participate as undefined rather than dropping it', () => {
        const [match] = runRegex('(a)|(b)', '', 'b').matches;

        expect(match?.groups).toEqual([
            { name: '1', value: undefined },
            { name: '2', value: 'b' },
        ]);
    });

    it('returns an error instead of throwing on an invalid pattern', () => {
        const result = runRegex('(unclosed', 'g', 'abc');

        expect(result.matches).toEqual([]);
        expect(result.error).toBeTruthy();
    });

    it('returns an error for an unsupported flag rather than throwing', () => {
        expect(runRegex('a', 'q', 'a').error).toBeTruthy();
    });

    // A global pattern that can match nothing advances lastIndex by zero, which
    // loops forever unless the cursor is nudged along.
    it('terminates on a zero-length global match', () => {
        const result = runRegex('a*', 'g', 'bb');

        expect(result.error).toBeNull();
        expect(result.matches.length).toBeLessThanOrEqual(3);
    });

    it('caps runaway match counts so the tab stays responsive', () => {
        const result = runRegex('.', 'g', 'x'.repeat(20000));

        expect(result.matches.length).toBeLessThanOrEqual(10000);
        expect(result.truncated).toBe(true);
    });
});
