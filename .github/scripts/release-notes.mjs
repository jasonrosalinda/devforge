#!/usr/bin/env node
// Generates release notes from conventional commits in a given tag range.
//   Args:  prevTag  currTag
//   Env:   GITHUB_REPOSITORY (e.g. "owner/repo")
// Outputs Markdown to stdout.

import { execSync } from 'node:child_process';

const prevTag = process.argv[2] || '';
const currTag = process.argv[3] || 'HEAD';
const repo = process.env.GITHUB_REPOSITORY || 'jasonrosalinda/devforge';
const repoUrl = `https://github.com/${repo}`;

const range = prevTag ? `${prevTag}..${currTag}` : currTag;
const sh = (cmd) => {
    try { return execSync(cmd, { encoding: 'utf8' }).trim(); }
    catch { return ''; }
};

const SEP = '<<<COMMIT_END>>>';
const FIELD = '<<<F>>>';
const log = sh(`git log ${range} --pretty=format:"%h${FIELD}%s${FIELD}%an${FIELD}%b${SEP}" --no-merges`);

const commits = log.split(SEP)
    .map(c => c.trim())
    .filter(Boolean)
    .map(c => {
        const [hash, subject, author, body] = c.split(FIELD);
        return {
            hash: (hash || '').trim(),
            subject: (subject || '').trim(),
            author: (author || '').trim(),
            body: (body || '').trim(),
        };
    })
    .filter(c =>
        c.hash &&
        c.subject &&
        !c.subject.startsWith('chore: release') &&
        c.author !== 'github-actions[bot]'
    );

const groups = {
    breaking: { title: '⚠️ Breaking Changes', items: [] },
    feat:     { title: '✨ Features',          items: [] },
    fix:      { title: '🐛 Bug Fixes',         items: [] },
    perf:     { title: '⚡ Performance',       items: [] },
    refactor: { title: '♻️ Refactors',         items: [] },
    docs:     { title: '📝 Documentation',    items: [] },
    other:    { title: '🔧 Other Changes',     items: [] },
};

const SCOPE_RE = /^([a-z]+)(\(([^)]+)\))?!?:\s*(.+)$/i;

for (const c of commits) {
    const m = c.subject.match(SCOPE_RE);
    const type = m?.[1]?.toLowerCase() ?? '';
    const scope = m?.[3] ?? '';
    const desc = m?.[4] ?? c.subject;
    const isBreaking = /BREAKING CHANGE/.test(c.body) || /^[a-z]+(\(.+\))?!:/.test(c.subject);

    const entry = { ...c, type, scope, desc, isBreaking };

    if (isBreaking) groups.breaking.items.push(entry);
    else if (type === 'feat') groups.feat.items.push(entry);
    else if (type === 'fix') groups.fix.items.push(entry);
    else if (type === 'perf') groups.perf.items.push(entry);
    else if (type === 'refactor') groups.refactor.items.push(entry);
    else if (type === 'docs') groups.docs.items.push(entry);
    else if (['chore', 'test', 'style', 'build', 'ci'].includes(type)) {
        // skipped — too noisy for release notes
    } else {
        groups.other.items.push(entry);
    }
}

const link = (sha) => `[\`${sha}\`](${repoUrl}/commit/${sha})`;

function renderEntry(e) {
    const scopeLabel = e.scope ? `**${e.scope}:** ` : '';
    let line = `- ${scopeLabel}${e.desc} (${link(e.hash)})`;
    // Include body lines that aren't BREAKING CHANGE markers or trailers
    if (e.body) {
        const bodyLines = e.body
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('BREAKING CHANGE:') && !/^[A-Z][a-z-]+: /.test(l));
        if (bodyLines.length) {
            const preview = bodyLines.slice(0, 3).join(' ').slice(0, 280);
            line += `\n  ${preview}${bodyLines.join(' ').length > 280 ? '...' : ''}`;
        }
    }
    return line;
}

let body = '';

// Header summary
if (commits.length === 0) {
    body += `_No user-facing changes in this release._\n\n`;
} else {
    const stats = {
        features: groups.feat.items.length,
        fixes: groups.fix.items.length,
        perf: groups.perf.items.length,
        breaking: groups.breaking.items.length,
    };
    const summary = [];
    if (stats.breaking) summary.push(`${stats.breaking} breaking change${stats.breaking === 1 ? '' : 's'}`);
    if (stats.features) summary.push(`${stats.features} new feature${stats.features === 1 ? '' : 's'}`);
    if (stats.fixes)    summary.push(`${stats.fixes} bug fix${stats.fixes === 1 ? '' : 'es'}`);
    if (stats.perf)     summary.push(`${stats.perf} performance improvement${stats.perf === 1 ? '' : 's'}`);
    if (summary.length) body += `> ${summary.join(' · ')}\n\n`;
}

// Sections
const order = ['breaking', 'feat', 'fix', 'perf', 'refactor', 'docs', 'other'];
for (const key of order) {
    const g = groups[key];
    if (!g.items.length) continue;
    body += `### ${g.title}\n\n`;
    body += g.items.map(renderEntry).join('\n') + '\n\n';
}

// Footer
if (prevTag) {
    body += `**Full Changelog**: ${repoUrl}/compare/${prevTag}...${currTag}\n`;
}

if (!body.trim()) {
    body = `Release ${currTag}\n`;
}

process.stdout.write(body);
