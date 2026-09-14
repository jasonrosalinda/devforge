import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(import.meta.url);
const { isSafeRef, capLines, AGENT_FLAGS, buildAttributionPrompt, validateRepo, resolveRef, gatherSeed } =
    require('./pagespeed-attribution.cjs').__test__;

// devForge's own repository stands in for a site repo — it has real tags and real
// history, so the git layer is exercised against git rather than a mock of it.
const REPO = process.cwd();

const { stripReportPreamble, subscriptionEnv, BILLING_OVERRIDE_VARS } = require('./claude-cli.cjs');

// devForge has no Anthropic API key of its own — every AI feature runs on the user's
// Claude Code CLI login. A machine-wide key set for some other tool must not silently
// redirect these runs to metered API billing.
describe('subscriptionEnv', () => {
    const withVars = (vars) => {
        const saved = {};
        for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
        try { return subscriptionEnv(); } finally {
            for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        }
    };

    it('strips every variable that could override the CLI login', () => {
        const env = withVars(Object.fromEntries(BILLING_OVERRIDE_VARS.map(v => [v, 'set-by-something-else'])));
        for (const name of BILLING_OVERRIDE_VARS) expect(env[name], name).toBeUndefined();
    });

    it('names the API key, the auth token and the cloud-provider routes', () => {
        expect(BILLING_OVERRIDE_VARS).toEqual(expect.arrayContaining([
            'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
            'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
        ]));
    });

    it('keeps the rest of the environment so the CLI still finds its login and PATH', () => {
        const env = withVars({ ANTHROPIC_API_KEY: 'sk-should-be-dropped' });
        expect(env.PATH ?? env.Path).toBeDefined();
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('applies extras while still stripping overrides', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-should-be-dropped';
        try {
            const env = subscriptionEnv({ GIT_PAGER: 'cat', ANTHROPIC_API_KEY: 'sk-also-dropped' });
            expect(env.GIT_PAGER).toBe('cat');
            expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        } finally {
            delete process.env.ANTHROPIC_API_KEY;
        }
    });
});

// An agentic run narrates while it investigates; that narration must not survive
// into the finished report.
describe('stripReportPreamble', () => {
    const HEADINGS = ['Findings', 'Assessment', 'Conclusion', 'Justification'];
    const report = '## Findings\n\n- LCP 7.7 s → 0.6 s\n\n## Conclusion\n\nA genuine improvement.';

    it('drops the investigation narration before the first heading', () => {
        expect(stripReportPreamble(`Now I have all the evidence needed.\n\n${report}`, HEADINGS)).toBe(report);
    });

    it('drops several lines of preamble', () => {
        const noisy = `Let me check the webpack config.\n\nOK — that explains it.\nNow I have all the evidence needed.\n\n${report}`;
        expect(stripReportPreamble(noisy, HEADINGS)).toBe(report);
    });

    it('leaves a clean report untouched', () => {
        expect(stripReportPreamble(report, HEADINGS)).toBe(report);
    });

    it('drops a trailing sign-off', () => {
        expect(stripReportPreamble(`${report}\n\nLet me know if you want me to dig further.`, HEADINGS)).toBe(report);
    });

    it('never eats content that merely looks conversational', () => {
        const withProse = '## Findings\n\n- LCP improved\n\n## Justification\n\nI have completed the comparison across both strategies.';
        // The closing line is inside a section and is the report's own prose — keep it.
        expect(stripReportPreamble(withProse, HEADINGS)).toContain('I have completed the comparison');
    });

    it('keeps everything when no heading is found rather than emptying the report', () => {
        const orphan = 'Some text with no headings at all.';
        expect(stripReportPreamble(orphan, HEADINGS)).toBe(orphan);
    });

    it('handles empty input', () => {
        expect(stripReportPreamble('', HEADINGS)).toBe('');
        expect(stripReportPreamble(undefined, HEADINGS)).toBe(undefined);
    });

    it('survives CRLF line endings', () => {
        expect(stripReportPreamble(`Now I have all the evidence needed.\r\n\r\n${report.replace(/\n/g, '\r\n')}`, HEADINGS)).toBe(report);
    });
});

describe('isSafeRef', () => {
    it('accepts the ref shapes a release label takes', () => {
        for (const ref of ['v3.14.1', '3.14.1', 'main', 'origin/main', 'refs/tags/v1.0', 'release/2026-09', 'HEAD~3', 'abc123def']) {
            expect(isSafeRef(ref), ref).toBe(true);
        }
    });

    it('rejects anything that could be read as an option or a range', () => {
        for (const ref of ['--upload-pack=touch x', '--exec=whoami', 'a..b', '', 'v1;rm -rf /', 'v1 && echo x', 'v1|cat', '$(whoami)', '`id`']) {
            expect(isSafeRef(ref), ref).toBe(false);
        }
    });

    it('rejects non-strings', () => {
        expect(isSafeRef(undefined)).toBe(false);
        expect(isSafeRef(42)).toBe(false);
    });
});

describe('capLines', () => {
    it('leaves short text alone', () => {
        expect(capLines('a\nb', 5)).toBe('a\nb');
    });

    it('truncates and says how much it dropped', () => {
        const out = capLines(Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n'), 3, 'use git log');
        expect(out.split('\n')).toHaveLength(4);
        expect(out).toContain('7 more line(s) omitted — use git log.');
    });

    it('handles empty input', () => {
        expect(capLines('', 5)).toBe('');
    });
});

// These flags are not style choices — each one was verified against Claude Code
// 2.1.270 and the run is unsafe without it. See the comment above AGENT_FLAGS.
describe('AGENT_FLAGS', () => {
    const flags = AGENT_FLAGS.join(' ');

    it('denies by default instead of asking a host that does not exist', () => {
        // `manual` was measured NOT to restrict anything in print mode.
        expect(flags).toContain('--permission-mode dontAsk');
        expect(flags).toContain('--permission-prompts none');
        expect(flags).not.toContain('--permission-mode manual');
        expect(flags).not.toContain('bypassPermissions');
    });

    it('keeps the target repository\'s own configuration out of the run', () => {
        expect(flags).toContain('--safe-mode');
        expect(flags).toContain('--strict-mcp-config');
        // --bare reads auth only from ANTHROPIC_API_KEY and would break subscription login.
        expect(flags).not.toContain('--bare');
    });

    it('explicitly denies every git subcommand that can modify the repository', () => {
        // The allowlist alone is not enough: `git checkout -- <file>` is classified as
        // a safe read and WILL discard uncommitted work unless denied by name.
        for (const sub of ['checkout', 'restore', 'reset', 'clean', 'stash', 'switch', 'rebase', 'merge', 'commit', 'push', 'pull', 'fetch', 'config', 'worktree']) {
            expect(flags, sub).toContain(`Bash(git ${sub}:*)`);
        }
    });

    it('denies the file-writing and network tools outright', () => {
        for (const tool of ['Write', 'Edit', 'NotebookEdit', 'PowerShell', 'WebFetch', 'WebSearch']) {
            expect(flags, tool).toContain(tool);
        }
    });

    it('allows only read-only investigation tools', () => {
        const allowed = /--allowedTools "([^"]+)"/.exec(flags)?.[1] ?? '';
        expect(allowed).toContain('Read');
        expect(allowed).toContain('Grep');
        expect(allowed).toContain('Bash(git log:*)');
        expect(allowed).not.toContain('Write');
    });

    it('caps spend', () => {
        expect(flags).toMatch(/--max-budget-usd \d/);
    });
});

describe('the git layer, against a real repository', () => {
    it('resolves a version label to a commit and describes it', async () => {
        const r = await resolveRef(REPO, 'v1.26.0');
        expect(r.resolved).toBe(true);
        expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
        expect(r.short).toHaveLength(8);
        expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });

    it('resolves a label the user typed without the v prefix', async () => {
        const withV = await resolveRef(REPO, 'v1.26.0');
        const without = await resolveRef(REPO, '1.26.0');
        expect(without.resolved).toBe(true);
        expect(without.sha).toBe(withV.sha);
    });

    // A release branch named after the version is the truer "what was deployed"
    // answer than a same-named tag, so it is tried first.
    it('prefers release/<label> over a tag of the same name', async () => {
        const repo = mkdtempSync(join(tmpdir(), 'ps-ref-'));
        const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
        try {
            git('init', '-q');
            git('config', 'user.email', 'p@p');
            git('config', 'user.name', 'p');
            writeFileSync(join(repo, 'a.txt'), 'one');
            git('add', '-A'); git('commit', '-qm', 'one');
            git('tag', 'v2.0.0');                       // tag points at the first commit
            const tagged = git('rev-parse', 'HEAD');
            writeFileSync(join(repo, 'a.txt'), 'two');
            git('add', '-A'); git('commit', '-qm', 'two');
            git('branch', 'release/v2.0.0');            // branch points at the second
            const branched = git('rev-parse', 'HEAD');

            const r = await resolveRef(repo, 'v2.0.0');
            expect(r.resolved).toBe(true);
            expect(r.ref).toBe('release/v2.0.0');
            expect(r.sha).toBe(branched);
            expect(r.sha).not.toBe(tagged);

            // A bare "2.0.0" must find release/v2.0.0 too.
            expect((await resolveRef(repo, '2.0.0')).sha).toBe(branched);
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it('falls back to the exact label when no release branch exists', async () => {
        const r = await resolveRef(REPO, 'v1.26.0');
        expect(r.resolved).toBe(true);
        expect(r.ref).toBe('v1.26.0');
    });

    it('offers nearby tags when a label does not resolve', async () => {
        const r = await resolveRef(REPO, 'v99.99.99');
        expect(r.resolved).toBe(false);
        expect(r.reason).toBe('REF_UNRESOLVED');
        expect(Array.isArray(r.candidates)).toBe(true);
    });

    it('rejects a folder that is not a git repository', async () => {
        await expect(validateRepo(require('os').tmpdir(), 'v1', 'v2')).rejects.toMatchObject({ code: 'NOT_A_GIT_REPO' });
    });

    it('canonicalises a subfolder to the repository root', async () => {
        // Users pick a subfolder as often as the root, and the root is not always the
        // working directory — ask git rather than assuming either.
        const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO })
            .toString().trim().replace(/\//g, '\\');
        const info = await validateRepo(`${REPO}/src/lib`, 'v1.26.0', 'v1.27.0');
        expect(info.root.toLowerCase()).toBe(toplevel.toLowerCase());
        expect(info.before.resolved && info.after.resolved).toBe(true);
    });

    it('seeds commits, a file breakdown and a directory rollup for a real range', async () => {
        const before = await resolveRef(REPO, 'v1.26.0');
        const after = await resolveRef(REPO, 'v1.27.0');
        const seed = await gatherSeed(REPO, before.sha, after.sha);
        expect(seed.commitCount).toBeGreaterThan(0);
        expect(seed.filesChanged).toBeGreaterThan(0);
        expect(seed.short).toMatch(/files? changed/);
        expect(seed.commits.split('\n')[0]).toMatch(/^[0-9a-f]{7,}\t\d{4}-\d{2}-\d{2}\t/);
        expect(seed.numstat.length).toBeGreaterThan(0);
    });

    it('warns instead of lying when the range holds no commits', async () => {
        const tag = await resolveRef(REPO, 'v1.27.0');
        const seed = await gatherSeed(REPO, tag.sha, tag.sha);
        expect(seed.commitCount).toBe(0);
        expect(seed.warnings.map(w => w.code)).toContain('NO_COMMITS_IN_RANGE');
    });
});

describe('buildAttributionPrompt', () => {
    const base = {
        before: { label: 'v3.14.0', short: 'aaaa1111', date: '2026-09-01' },
        after: { label: 'v3.14.1', short: 'bbbb2222', date: '2026-09-14' },
        repoRoot: 'C:\\repos\\site',
        remote: 'git@example.com:org/site.git',
        urls: ['https://sit.example.com/a'],
        seed: { short: '3 files changed', commits: 'aaa\t2026-09-02\tdev\tAdd hero image', dirstat: '', numstat: '', buildFiles: '' },
        evidence: '### Evidence diff\n- something',
        warnings: [{ code: 'REPO_DIRTY', message: '2 uncommitted changes.' }],
    };

    it('names both refs, the repo and the caveats', () => {
        const p = buildAttributionPrompt(base);
        expect(p).toContain('v3.14.0` → commit aaaa1111');
        expect(p).toContain('v3.14.1` → commit bbbb2222');
        expect(p).toContain('C:\\repos\\site');
        expect(p).toContain('REPO_DIRTY: 2 uncommitted changes.');
    });

    it('says "none" when there are no caveats', () => {
        expect(buildAttributionPrompt({ ...base, warnings: [] })).toContain('- none');
    });

    it('demands an explicit escape hatch instead of a guess', () => {
        const p = buildAttributionPrompt(base);
        expect(p).toContain('**Insufficient evidence in this repository.**');
        expect(p).toContain('Never invent a SHA');
    });

    it('restates the output contract after the data so it survives a long transcript', () => {
        const p = buildAttributionPrompt(base);
        const first = p.indexOf('## OUTPUT CONTRACT');
        const restated = p.indexOf('## OUTPUT CONTRACT (restated');
        expect(first).toBeGreaterThan(-1);
        expect(restated).toBeGreaterThan(first);
        // The seeded data sits between the two statements of the contract.
        expect(p.indexOf('## SEEDED GIT DATA')).toBeGreaterThan(first);
    });

    // Both buttons produce a report in the same card, so they share one shape.
    it('asks for the same four sections as the plain assessment', () => {
        const p = buildAttributionPrompt(base);
        for (const heading of ['## Findings', '## Assessment', '## Conclusion', '## Justification']) {
            expect(p, heading).toContain(heading);
        }
        expect(p).not.toContain('## Cause Attribution');
        expect(p).not.toContain('## Verdict');
        // …but still demands the code evidence the plain assessment cannot give.
        expect(p).toContain('**Evidence:** commit');
        expect(p).toContain('**Confidence:**');
    });

    it('tells the agent which commands are blocked so it does not burn turns', () => {
        const p = buildAttributionPrompt(base);
        expect(p).toContain('those pipes are BLOCKED');
        expect(p).toContain('Do NOT run git checkout');
        expect(p).toContain('Writes are BLOCKED');
    });

    it('carries the PageSpeed evidence through verbatim', () => {
        expect(buildAttributionPrompt(base)).toContain('### Evidence diff\n- something');
    });
});
