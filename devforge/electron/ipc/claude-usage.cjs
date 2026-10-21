'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ipcMain } = require('electron');

// Claude Code plan usage (the numbers `/usage` shows) for the sidebar.
//
// Reads the CLI's own OAuth login and asks Anthropic how much of the plan's session
// and weekly limits are used. Read-only: nothing is generated, so nothing is billed.
// The endpoint is the one Claude Code itself calls and is undocumented — any shape
// drift is reported as "unavailable" rather than thrown.
//
// The token is never refreshed here. Refreshing rotates the refresh token, and the
// CLI would then hold a dead one; any `claude` run refreshes it for us instead.

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TIMEOUT_MS = 10000;

const tagged = (message, code) => Object.assign(new Error(message), { code });

/** ~/.claude, or wherever CLAUDE_CONFIG_DIR points the CLI. */
function claudeConfigDir(env = process.env) {
    return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** The CLI's OAuth access token, or a tagged NOT_SIGNED_IN / EXPIRED error. */
function readAccessToken(dir = claudeConfigDir(), now = Date.now()) {
    let oauth;
    try {
        oauth = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth;
    } catch {
        throw tagged('No Claude Code login found.', 'NOT_SIGNED_IN');
    }
    if (!oauth?.accessToken) throw tagged('No Claude Code login found.', 'NOT_SIGNED_IN');
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= now) {
        throw tagged('Claude Code login expired.', 'EXPIRED');
    }
    return { token: oauth.accessToken, plan: oauth.subscriptionType ?? null };
}

// Window keys in display order. The per-model weekly windows are null on plans
// that don't have them, and are then left out.
const WINDOWS = [
    ['five_hour', 'session', 'Session'],
    ['seven_day', 'weekly', 'Weekly'],
    ['seven_day_opus', 'weekly_opus', 'Weekly · Opus'],
    ['seven_day_sonnet', 'weekly_sonnet', 'Weekly · Sonnet'],
];

/** Normalise the endpoint's response to the windows the sidebar shows. */
function parseUsage(json) {
    const limits = [];
    for (const [key, id, label] of WINDOWS) {
        const w = json?.[key];
        if (!w || typeof w.utilization !== 'number') continue;
        limits.push({
            id,
            label,
            percent: Math.max(0, Math.min(100, Math.round(w.utilization))),
            resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null,
        });
    }
    if (limits.length === 0) throw tagged('Usage response had no limits.', 'BAD_RESPONSE');
    return limits;
}

async function fetchUsage({ dir, fetchImpl = fetch, now = Date.now() } = {}) {
    try {
        const { token, plan } = readAccessToken(dir, now);
        const res = await fetchImpl(USAGE_URL, {
            headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status === 401) throw tagged('Claude Code login expired.', 'EXPIRED');
        if (!res.ok) throw tagged(`Usage request failed (HTTP ${res.status}).`, 'HTTP_ERROR');
        return { success: true, plan, limits: parseUsage(await res.json()), fetchedAt: new Date(now).toISOString() };
    } catch (err) {
        return { success: false, code: err.code ?? 'NETWORK', error: err.message || String(err) };
    }
}

module.exports = function registerClaudeUsageHandlers() {
    ipcMain.handle('claude-usage:fetch', () => fetchUsage());
};

module.exports._readAccessToken = readAccessToken;
module.exports._parseUsage = parseUsage;
module.exports._fetchUsage = fetchUsage;
module.exports._claudeConfigDir = claudeConfigDir;
