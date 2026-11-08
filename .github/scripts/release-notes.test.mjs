// Run: node --test .github/scripts/release-notes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNotes, parseLog, summarize, toEntries } from './release-notes.mjs';

const F = '<<<F>>>';
const E = '<<<COMMIT_END>>>';
const commit = (hash, subject, body = '', author = 'Dev') => ({ hash, subject, author, body });

test('parseLog drops release bumps and bot commits', () => {
    const log = [
        `a1${F}feat: one${F}Dev${F}body${E}`,
        `b2${F}chore: release v2.13.0${F}github-actions[bot]${F}${E}`,
        `c3${F}fix: two${F}github-actions[bot]${F}${E}`,
    ].join('\n');
    assert.deepEqual(parseLog(log).map((c) => c.hash), ['a1']);
});

test('summarize keeps the first sentence and strips boilerplate, trailers and list items', () => {
    assert.equal(summarize('This commit introduces new types. And more.\n\nSecond para.'), 'Introduces new types.');
    assert.equal(summarize('Co-Authored-By: X <x@y>\n* feat: a\nReal text here'), 'Real text here');
    assert.equal(summarize(''), '');
    assert.ok(summarize('x'.repeat(300)).length <= 200);
});

test('a squash merge lists one entry per conventional item, with the PR', () => {
    const entries = toEntries(commit('s1', 'Release pilot (#12)', '* feat(pilot): add runbook\n* fix: crash on load\n* chore: tidy'));
    assert.deepEqual(entries.map((e) => [e.type, e.scope, e.desc, e.pr]), [
        ['feat', 'pilot', 'add runbook', '12'],
        ['fix', '', 'crash on load', '12'],
        ['chore', '', 'tidy', '12'],
    ]);
});

test('a merged PR with a chore prefix is kept as Other, a plain chore is dropped', () => {
    const notes = buildNotes([
        commit('p1', 'chore: Add app investigation (#9)', 'Introduces a page.'),
        commit('c1', 'chore: bump deps'),
        commit('ci1', 'ci: cache npm'),
    ]);
    assert.match(notes, /### 🔧 Other Changes\n\n- Add app investigation — Introduces a page\. \(\[#9\]/);
    assert.doesNotMatch(notes, /bump deps|cache npm/);
});

test('breaking changes come first, from "!" or a BREAKING CHANGE body', () => {
    const notes = buildNotes([
        commit('f1', 'feat: new thing'),
        commit('b1', 'feat(api)!: drop v1'),
        commit('b2', 'fix: change config', 'BREAKING CHANGE: key renamed'),
    ]);
    assert.ok(notes.indexOf('Breaking Changes') < notes.indexOf('Features'));
    assert.match(notes, /\*\*1 breaking change|\*\*2 breaking changes/);
    assert.match(notes, /\*\*api:\*\* Drop v1/);
});

test('summary line, dedupe, links and install section', () => {
    const notes = buildNotes([
        commit('a1', 'feat: same thing'),
        commit('a2', 'feat: Same thing'),
        commit('f1', 'fix: a bug'),
    ], { prevTag: 'v1.0.0', currTag: 'v1.1.0', repo: 'o/r' });
    assert.ok(notes.startsWith('**1 new feature · 1 bug fix** since v1.0.0\n'));
    assert.equal((notes.match(/Same thing/gi) || []).length, 1);
    // The commit link sits in its own parentheses, which the in-app renderer strips.
    assert.match(notes, / \(\[`a1`\]\(https:\/\/github\.com\/o\/r\/commit\/a1\)\)/);
    assert.match(notes, /devForge\.Setup\.1\.1\.0\.exe\]\(https:\/\/github\.com\/o\/r\/releases\/download\/v1\.1\.0\//);
    assert.match(notes, /\*\*Full Changelog\*\*: https:\/\/github\.com\/o\/r\/compare\/v1\.0\.0\.\.\.v1\.1\.0/);
    // Only the renderer's subset: no blockquotes, no indented continuation lines.
    assert.doesNotMatch(notes, /^>|^ {2}\S/m);
});

test('no changes and no version tag: note only, no install section', () => {
    const notes = buildNotes([commit('c1', 'chore: x')], { currTag: 'HEAD' });
    assert.match(notes, /No user-facing changes/);
    assert.doesNotMatch(notes, /Install/);
});
