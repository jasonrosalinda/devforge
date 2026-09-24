export type RegexWarning = { construct: string; message: string };

export type RegexGroup = { name: string; value: string | undefined };

export type RegexMatch = {
    index: number;
    length: number;
    text: string;
    groups: RegexGroup[];
};

export type RegexRunResult = {
    matches: RegexMatch[];
    error: string | null;
    /** True when matching stopped at MAX_MATCHES rather than at the end of the input. */
    truncated: boolean;
};

/** Enough to inspect a pattern; past this the table stops being readable anyway. */
export const MAX_MATCHES = 10000;

type LintRule = { construct: string; detect: RegExp; message: string };

/**
 * Constructs .NET's regex engine accepts that JavaScript's either rejects or
 * reads differently. The tester runs patterns through the JS engine — a browser
 * has no other option — so these warnings are what keeps that honest for a
 * .NET codebase.
 */
const RULES: LintRule[] = [
    {
        construct: 'balancing-group',
        detect: /\(\?<\w*-\w+>/,
        message: 'Balancing groups like (?<close-open>…) are a .NET feature for matching nested constructs. JavaScript has no equivalent and will reject this pattern.',
    },
    {
        construct: 'conditional',
        detect: /\(\?\(/,
        message: 'Conditional matching (?(group)yes|no) is .NET-only. JavaScript has no conditional construct, so this pattern will not compile here.',
    },
    {
        construct: 'atomic-group',
        detect: /\(\?>/,
        message: 'Atomic groups (?>…) prevent backtracking in .NET. JavaScript does not support them, so backtracking behaviour and catastrophic-backtracking risk differ.',
    },
    {
        construct: 'inline-comment',
        detect: /\(\?#/,
        message: 'Inline comments (?#…) are valid in .NET but not in JavaScript, where they are parsed as a group and change what the pattern matches.',
    },
    {
        // Letters only, so (?:, (?=, (?!, (?<= and (?<! are untouched.
        construct: 'inline-options',
        detect: /\(\?[imnsx]+[-:)]/,
        message: 'Inline options such as (?i) or (?im:…) are set differently in JavaScript, which only takes flags on the whole pattern. Use the flag toggles instead.',
    },
    {
        construct: 'end-anchor',
        detect: /\\[Zz]/,
        message: '\\Z and \\z anchor to the end of the string in .NET, with \\Z allowing a trailing newline. JavaScript has neither; $ with the m flag behaves differently.',
    },
    {
        construct: 'unicode-category',
        detect: /\\[pP]\{/,
        message: 'Unicode categories and blocks are named differently in .NET (\\p{IsGreek}) than in JavaScript (\\p{Script=Greek}, and only with the u flag).',
    },
];

/** Warnings for every distinct .NET-specific construct in the pattern, each reported once. */
export function lintDotNetDifferences(pattern: string): RegexWarning[] {
    return RULES
        .filter((rule) => rule.detect.test(pattern))
        .map(({ construct, message }) => ({ construct, message }));
}

/**
 * Names of the capturing groups in source order, null where a group is
 * unnamed. Read from the pattern rather than from match.groups, because two
 * groups can capture identical text and matching by value mixes them up.
 */
function captureNames(pattern: string): (string | null)[] {
    const names: (string | null)[] = [];
    let inCharacterClass = false;

    for (let i = 0; i < pattern.length; i += 1) {
        const char = pattern[i];

        if (char === '\\') {
            i += 1;
            continue;
        }
        if (inCharacterClass) {
            if (char === ']') inCharacterClass = false;
            continue;
        }
        if (char === '[') {
            inCharacterClass = true;
            continue;
        }
        if (char !== '(') continue;

        if (pattern[i + 1] !== '?') {
            names.push(null);
            continue;
        }

        // (?<name> captures; (?:, (?=, (?!, (?<= and (?<! do not.
        const named = /^\(\?<([A-Za-z_$][\w$]*)>/.exec(pattern.slice(i));
        if (named) names.push(named[1]!);
    }

    return names;
}

function toGroups(match: RegExpExecArray, names: (string | null)[]): RegexGroup[] {
    return match.slice(1).map((value, index) => ({
        name: names[index] ?? String(index + 1),
        value,
    }));
}

/** Runs the pattern through the JavaScript engine, reporting errors instead of throwing. */
export function runRegex(pattern: string, flags: string, input: string): RegexRunResult {
    let regex: RegExp;
    try {
        regex = new RegExp(pattern, flags);
    } catch (error) {
        return { matches: [], error: (error as Error).message, truncated: false };
    }

    const names = captureNames(pattern);
    const matches: RegexMatch[] = [];

    if (!regex.global) {
        const match = regex.exec(input);
        if (match) {
            matches.push({ index: match.index, length: match[0].length, text: match[0], groups: toGroups(match, names) });
        }
        return { matches, error: null, truncated: false };
    }

    let match: RegExpExecArray | null;
    while ((match = regex.exec(input)) !== null) {
        matches.push({ index: match.index, length: match[0].length, text: match[0], groups: toGroups(match, names) });

        // A zero-length match leaves lastIndex where it was; step over it or
        // exec() returns the same empty match forever.
        if (match[0] === '') regex.lastIndex += 1;

        if (matches.length >= MAX_MATCHES) {
            return { matches, error: null, truncated: true };
        }
    }

    return { matches, error: null, truncated: false };
}
