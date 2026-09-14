'use strict';

// Shared headless Claude CLI runner.
//
// Extracted from pagespeed-insight.cjs so the no-tools analysis and the agentic
// repository investigation share one NDJSON parser, one "CLI not found" path and
// one cancel mechanism. Adds two things the original lacked: a tree kill (see
// killTree) and an onEvent hook, so an agentic run can separate its investigation
// narration from the report text.

const { spawn, execFile } = require('child_process');

const tagged = (message, code) => Object.assign(new Error(message), { code });

// devForge deliberately has no Anthropic API key of its own: every AI feature runs
// through the user's Claude Code CLI login. These variables would override that login
// and route the run to metered API / Bedrock / Vertex billing instead, so they are
// stripped from the child environment — a machine-wide ANTHROPIC_API_KEY set for some
// other tool must not silently start charging per token for a devForge assessment.
const BILLING_OVERRIDE_VARS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_ORGANIZATION_ID',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
];

/** process.env with every billing override removed, plus any extras to add. */
function subscriptionEnv(extra = {}) {
    const env = { ...process.env, ...extra };
    for (const name of BILLING_OVERRIDE_VARS) delete env[name];
    return env;
}

// shell:true is mandatory on Windows — `claude` is a .cmd shim and Node >= 20.12
// refuses to spawn .cmd without a shell (CVE-2024-27980). The consequence is that
// child.pid is cmd.exe, NOT claude, so child.kill() reaps the wrapper and leaves the
// real process running. A 15-minute agentic run that ignores cancel keeps spending
// money and keeps touching the user's repository, so kill the whole tree.
function killTree(child) {
    if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32') {
        try {
            execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { });
            return;
        } catch { /* fall through to the signal below */ }
    }
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

/**
 * Run the Claude CLI headless, streaming assistant text as it arrives.
 *
 * @param {object}   o
 * @param {string}   o.directive    short, QUOTE-FREE text for the command line
 * @param {string}   o.promptBody   the large payload — always sent on stdin
 * @param {string[]} [o.flags]      pre-quoted argv fragments, appended verbatim
 * @param {string}   o.cwd
 * @param {object}   [o.env]
 * @param {number}   [o.timeoutMs]  hard wall clock
 * @param {number}   [o.idleMs]     kill after this long with no stdout (0 = off)
 * @param {(text: string) => void}   [o.onText]
 * @param {(evt: object) => void}    [o.onEvent]
 * @param {{ child: any, cancelled: boolean }} [o.handle]  caller-owned cancel handle
 * @returns {Promise<{ text: string, meta: object }>}
 */
function runClaudeCli({
    directive, promptBody, flags = [], cwd, env,
    timeoutMs = 300000, idleMs = 0, onText, onEvent, handle,
}) {
    return new Promise((resolve, reject) => {
        const command = [`claude -p "${directive}"`, ...flags].join(' ');
        let child;
        try {
            child = spawn(command, { shell: true, cwd, env: subscriptionEnv(env), windowsHide: true });
        } catch (err) {
            reject(tagged(`Failed to launch Claude CLI: ${err.message}`, 'CLI_SPAWN_FAILED'));
            return;
        }
        if (handle) handle.child = child;

        let buf = '';
        let streamed = '';
        let resultText = '';
        let errOut = '';
        let settled = false;
        let meta = {};
        let idleTimer = null;

        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            clearTimeout(hardTimer);
            clearTimeout(idleTimer);
            if (handle) handle.child = null;
            fn(arg);
        };

        const hardTimer = setTimeout(() => {
            killTree(child);
            finish(reject, tagged(`Claude run exceeded ${Math.round(timeoutMs / 60000)} minute(s).`, 'TIMEOUT'));
        }, timeoutMs);

        // An agentic run legitimately goes quiet during a long Grep; silence for
        // minutes means it is wedged, which the wall clock alone would not catch
        // until the very end.
        const bumpIdle = () => {
            if (!idleMs) return;
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                killTree(child);
                finish(reject, tagged(`Claude produced no output for ${Math.round(idleMs / 1000)}s.`, 'IDLE_TIMEOUT'));
            }, idleMs);
        };
        bumpIdle();

        const emit = (text) => {
            if (!text) return;
            streamed += text;
            try { onText && onText(text); } catch { /* ignore */ }
        };

        const handleLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            let evt;
            try { evt = JSON.parse(trimmed); } catch { emit(line); return; } // non-JSON → pass through
            try { onEvent && onEvent(evt); } catch { /* ignore */ }
            if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
                emit(evt.message.content.filter(c => c?.type === 'text').map(c => c.text).join(''));
            } else if (evt.type === 'result') {
                // Cached input is billed differently but is still work the run did, so
                // every bucket counts toward the total the UI shows.
                const u = evt.usage ?? {};
                const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
                const output = u.output_tokens ?? 0;
                meta = {
                    costUsd: evt.total_cost_usd,
                    tokens: {
                        input,
                        output,
                        cacheRead: u.cache_read_input_tokens ?? 0,
                        cacheCreation: u.cache_creation_input_tokens ?? 0,
                        total: input + output,
                    },
                    numTurns: evt.num_turns,
                    durationMs: evt.duration_ms,
                    sessionId: evt.session_id,
                    subtype: evt.subtype,
                    permissionDenials: evt.permission_denials ?? [],
                };
                // The result event is authoritative — streamed text can include
                // narration the final answer drops.
                if (typeof evt.result === 'string') resultText = evt.result;
                if (evt.subtype && evt.subtype !== 'success' && evt.error) errOut += String(evt.error);
            }
        };

        child.on('error', (err) => {
            const missing = /ENOENT|not recognized|not found/i.test(err.message);
            finish(reject, missing
                ? tagged('Claude CLI not found on PATH — install Claude Code or check your PATH.', 'CLI_MISSING')
                : tagged(`Claude CLI error: ${err.message}`, 'CLI_SPAWN_FAILED'));
        });
        child.stdout.on('data', (d) => {
            bumpIdle();
            buf += d.toString();
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                handleLine(buf.slice(0, idx));
                buf = buf.slice(idx + 1);
            }
        });
        child.stderr.on('data', (d) => { errOut += d.toString(); });
        child.on('close', (code) => {
            if (buf.trim()) handleLine(buf); // flush trailing partial line
            if (handle?.cancelled) return finish(reject, tagged('Cancelled.', 'CANCELLED'));
            const final = (resultText || streamed).trim();
            if (code === 0 && final) return finish(resolve, { text: final, meta });
            if (/not recognized|ENOENT|not found/i.test(errOut)) {
                return finish(reject, tagged('Claude CLI not found on PATH — install Claude Code or check your PATH.', 'CLI_MISSING'));
            }
            const tail = errOut.trim().slice(-400);
            finish(reject, tagged(`Claude run failed (exit ${code}).${tail ? ' ' + tail : ''}`, 'AGENT_FAILED'));
        });

        try {
            child.stdin.write(promptBody);
            child.stdin.end();
        } catch (err) {
            finish(reject, tagged(`Failed to send data to Claude: ${err.message}`, 'STDIN_FAILED'));
        }
    });
}

// Lines a model tacks on around a finished report — "Now I have all the evidence
// needed.", "Let me know if you want…". The prompt forbids them, but prompt
// compliance is not guaranteed, so the output is trimmed too.
// Kept deliberately narrow. "I have completed the comparison across both strategies"
// is legitimate report prose in a Justification section, so first-person phrasing is
// NOT a narration signal — only unambiguous sign-offs are.
const TRAILING_NARRATION = [
    /^(let me know|hope this helps|feel free)\b/i,
    /^analysis complete\b/i,
    /^(that|this) (completes|concludes)\b/i,
];

/**
 * Drop everything before the report's first real section heading, plus any sign-off
 * after it. An agentic run narrates while it investigates ("Now I have all the
 * evidence needed."), and that narration must not open the report.
 *
 * @param {string} markdown
 * @param {string[]} headings section names that may legitimately start the report
 */
function stripReportPreamble(markdown, headings) {
    if (!markdown) return markdown;
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const opener = new RegExp(`^#{1,3}\\s*(${headings.join('|')})\\b`, 'i');

    const first = lines.findIndex(l => opener.test(l.trim()));
    const start = first > 0 ? first : 0;

    let end = lines.length;
    while (end > start) {
        const line = lines[end - 1].trim();
        // Never discard structure or data, whatever it says.
        if (!line) { end--; continue; }
        if (/^[#>|\-*\d]|^```/.test(line)) break;
        if (TRAILING_NARRATION.some(re => re.test(line))) { end--; continue; }
        break;
    }

    return lines.slice(start, end).join('\n').trim();
}

module.exports = { runClaudeCli, killTree, tagged, stripReportPreamble, subscriptionEnv, BILLING_OVERRIDE_VARS };
