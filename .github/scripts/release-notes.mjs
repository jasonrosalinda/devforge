#!/usr/bin/env node
// Generates release notes from conventional commits in a given tag range.
//   Args:  prevTag  currTag
//   Env:   GITHUB_REPOSITORY (e.g. "owner/repo")
// Outputs Markdown to stdout.
//
// The notes are shown on the GitHub release and in devForge's own Release notes
// tab, whose renderer knows only "### " headings, "- " list items, **bold**,
// [links](url) and `code`. Everything here stays inside that subset: no
// blockquotes, no nested or multi-line list items, no HTML.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SEP = '<<<COMMIT_END>>>';
const FIELD = '<<<F>>>';

const GROUPS = [
    ['breaking', '⚠️ Breaking Changes'],
    ['feat', '✨ Features'],
    ['fix', '🐛 Bug Fixes'],
    ['perf', '⚡ Performance'],
    ['refactor', '♻️ Refactors'],
    ['docs', '📝 Documentation'],
    ['other', '🔧 Other Changes'],
];
// Types that never reach the notes on their own: housekeeping, not something a user notices.
const NOISE = new Set(['chore', 'test', 'style', 'build', 'ci']);

const CONVENTIONAL = /^([a-z]+)(\(([^)]+)\))?(!)?:\s*(.+)$/i;
// A squash merge lists its commits in the body as "* feat(x): ..." / "- fix: ...".
const BODY_ITEM = /^[*-]\s+([a-z]+(\([^)]+\))?!?:\s*.+)$/i;
const PR_REF = /\s*\(#(\d+)\)\s*$/;
const TRAILER = /^[A-Z][A-Za-z-]+: /;
const SUMMARY_MAX = 200;

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** `git log` output (the format main() asks for) to commit objects, minus release bumps and bot commits. */
export function parseLog(log) {
    return log.split(SEP)
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => {
            const [hash, subject, author, body] = c.split(FIELD);
            return {
                hash: (hash || '').trim(),
                subject: (subject || '').trim(),
                author: (author || '').trim(),
                body: (body || '').trim(),
            };
        })
        .filter((c) => c.hash && c.subject && !/^chore: release\b/.test(c.subject) && c.author !== 'github-actions[bot]');
}

/** First sentence of the body's first paragraph, without trailers or squash-merge item lines. */
export function summarize(body) {
    const para = [];
    for (const raw of body.split('\n')) {
        const line = raw.trim();
        if (!line) { if (para.length) break; continue; }
        if (TRAILER.test(line) || line.startsWith('BREAKING CHANGE') || BODY_ITEM.test(line)) continue;
        para.push(line);
    }
    // "This commit introduces X" reads as "Introduces X" in a list of changes.
    const text = capitalize(para.join(' ').replace(/^this (commit|pr|pull request|change)\s+/i, ''));
    if (!text) return '';
    const sentence = (text.match(/^.+?[.!?](\s|$)/)?.[0] ?? text).trim();
    return sentence.length > SUMMARY_MAX ? `${sentence.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : sentence;
}

function classify(line) {
    const m = line.match(CONVENTIONAL);
    if (!m) return { type: '', scope: '', desc: line, bang: false };
    return { type: m[1].toLowerCase(), scope: m[3] ?? '', desc: m[5].trim(), bang: !!m[4] };
}

/**
 * Each commit as one or more note entries. A squash merge that lists conventional
 * commits in its body becomes one entry per listed commit. A merged PR is never
 * dropped as noise, whatever its own prefix says: a whole PR is a user-visible change.
 */
export function toEntries(commit) {
    const pr = commit.subject.match(PR_REF)?.[1] ?? '';
    const subject = commit.subject.replace(PR_REF, '');
    const breakingBody = /BREAKING CHANGE/.test(commit.body);
    const items = commit.body.split('\n').map((l) => l.trim().match(BODY_ITEM)?.[1]).filter(Boolean);

    if (pr && items.length) {
        return items.map((line) => {
            const c = classify(line);
            return { ...c, hash: commit.hash, pr, summary: '', breaking: c.bang };
        });
    }
    const c = classify(subject);
    const type = pr && (NOISE.has(c.type) || !c.type) ? 'other' : c.type;
    return [{ ...c, type, hash: commit.hash, pr, summary: summarize(commit.body), breaking: c.bang || breakingBody }];
}

function groupOf(e) {
    if (e.breaking) return 'breaking';
    if (['feat', 'fix', 'perf', 'refactor', 'docs'].includes(e.type)) return e.type;
    if (NOISE.has(e.type)) return null;
    return 'other';
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The release notes Markdown for `commits` (from parseLog). */
export function buildNotes(commits, { prevTag = '', currTag = 'HEAD', repo = 'jasonrosalinda/devforge' } = {}) {
    const repoUrl = `https://github.com/${repo}`;
    const grouped = Object.fromEntries(GROUPS.map(([k]) => [k, []]));
    const seen = new Set();
    for (const commit of commits) {
        for (const e of toEntries(commit)) {
            const g = groupOf(e);
            const dedupe = `${g}|${e.scope}|${e.desc.toLowerCase()}`;
            if (!g || seen.has(dedupe)) continue;
            seen.add(dedupe);
            grouped[g].push(e);
        }
    }

    const renderEntry = (e) => {
        const scope = e.scope ? `**${e.scope}:** ` : '';
        const summary = e.summary && e.summary.toLowerCase() !== e.desc.toLowerCase() ? ` — ${e.summary}` : '';
        // Commit link in its own parentheses: the in-app renderer strips exactly that shape.
        const pr = e.pr ? ` ([#${e.pr}](${repoUrl}/pull/${e.pr}))` : '';
        return `- ${scope}${capitalize(e.desc)}${summary}${pr} ([\`${e.hash}\`](${repoUrl}/commit/${e.hash}))`;
    };

    const counts = [
        [grouped.breaking.length, 'breaking change', 'breaking changes'],
        [grouped.feat.length, 'new feature', 'new features'],
        [grouped.fix.length, 'bug fix', 'bug fixes'],
        [grouped.perf.length, 'performance improvement', 'performance improvements'],
    ].filter(([n]) => n).map(([n, one, many]) => plural(n, one, many));
    const total = GROUPS.reduce((s, [k]) => s + grouped[k].length, 0);

    let out = '';
    if (!total) {
        out += '_No user-facing changes in this release._\n\n';
    } else {
        const since = prevTag ? ` since ${prevTag}` : '';
        out += `**${counts.length ? counts.join(' · ') : plural(total, 'change', 'changes')}**${since}\n\n`;
    }

    for (const [key, title] of GROUPS) {
        if (!grouped[key].length) continue;
        out += `### ${title}\n\n${grouped[key].map(renderEntry).join('\n')}\n\n`;
    }

    // Matches the artifact names in devforge/electron-builder.json5.
    const version = currTag.replace(/^v/, '');
    if (/^\d+\.\d+\.\d+/.test(version)) {
        const dl = (file) => `[${file}](${repoUrl}/releases/download/${currTag}/${file})`;
        out += '### 📦 Install\n\n';
        out += `- Windows installer: ${dl(`devForge.Setup.${version}.exe`)}\n`;
        out += `- Windows portable: ${dl(`devForge.${version}.exe`)}\n`;
        out += '- Already installed? devForge downloads this update by itself and installs it on restart.\n\n';
    }

    if (prevTag) out += `**Full Changelog**: ${repoUrl}/compare/${prevTag}...${currTag}\n`;
    return out;
}

function main() {
    const prevTag = process.argv[2] || '';
    const currTag = process.argv[3] || 'HEAD';
    const repo = process.env.GITHUB_REPOSITORY || 'jasonrosalinda/devforge';
    const range = prevTag ? `${prevTag}..${currTag}` : currTag;
    let log = '';
    try {
        // Argument array, no shell: the tags come from the command line.
        log = execFileSync('git', ['log', range, `--pretty=format:%h${FIELD}%s${FIELD}%an${FIELD}%b${SEP}`, '--no-merges'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch { /* no history in range: falls through to the no-changes note */ }
    process.stdout.write(buildNotes(parseLog(log), { prevTag, currTag, repo }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
