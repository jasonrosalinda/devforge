const { ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ─── Thresholds ───────────────────────────────────────────────────────────────

const THRESHOLDS = {
    speedIndex:             { good: 3400,  poor: 5800  },
    largestContentfulPaint: { good: 2500,  poor: 4000  },
    cumulativeLayoutShift:  { good: 0.1,   poor: 0.25  },
    totalBlockingTime:      { good: 200,   poor: 600   },
    firstContentfulPaint:   { good: 1800,  poor: 3000  },
    interactive:            { good: 3800,  poor: 7300  },
};

function ratingLabel(metric, key) {
    const v = metric?.numericValue;
    if (v == null) return '—';
    const t = THRESHOLDS[key];
    if (!t) return '—';
    if (v <= t.good) return '🟢 Good';
    if (v <= t.poor) return '🟡 Needs Improvement';
    return '🔴 Poor';
}

// Keep for comparison mode tables
function rating(metric, key) {
    const v = metric?.numericValue;
    if (v == null) return '—';
    const t = THRESHOLDS[key];
    if (!t) return '—';
    if (v <= t.good) return '✅ Good';
    if (v <= t.poor) return '⚠️ Needs Improvement';
    return '❌ Poor';
}

function scoreRating(score) {
    if (score == null) return '';
    if (score >= 90) return '🟢 Good';
    if (score >= 50) return '🟡 Needs Improvement';
    return '🔴 Poor';
}

// ─── Markdown helpers ─────────────────────────────────────────────────────────

function mdTable(headers, rows) {
    if (!rows.length) return '_No data._\n';
    const head = '| ' + headers.join(' | ') + ' |';
    const sep  = '| ' + headers.map(() => '---').join(' | ') + ' |';
    const body = rows.map(r => '| ' + r.map(c => String(c ?? '—').replace(/\|/g, '\\|')).join(' | ') + ' |').join('\n');
    return `${head}\n${sep}\n${body}\n`;
}

function formatDetailValue(value, valueType) {
    if (value == null) return '—';
    // Handle nested Lighthouse node/source objects
    if (typeof value === 'object') {
        return String(value.url ?? value.text ?? value.nodeLabel ?? JSON.stringify(value)).slice(0, 80);
    }
    switch (valueType) {
        case 'timespanMs':
        case 'ms':
            return typeof value === 'number'
                ? value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`
                : String(value);
        case 'bytes':
            return typeof value === 'number'
                ? value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(2)} MB`
                : value >= 1024       ? `${(value / 1024).toFixed(2)} KB`
                :                       `${value} B`
                : String(value);
        case 'url':
        case 'source':
            return String(value).length > 80 ? String(value).slice(0, 77) + '...' : String(value);
        case 'numeric':
        case 'unitless':
            return typeof value === 'number' ? value.toLocaleString('en') : String(value);
        default:
            return String(value).length > 80 ? String(value).slice(0, 77) + '...' : String(value);
    }
}

function renderAuditDetails(details) {
    if (!details?.items?.length || !details?.headings?.length) return '';
    const heads = details.headings.filter(h => h.key && h.label);
    if (!heads.length) return '';
    const rows = details.items.map(item =>
        heads.map(h => formatDetailValue(item[h.key], h.valueType))
    );
    return mdTable(heads.map(h => h.label), rows) + '\n';
}

// ─── Per-URL detailed renderer ────────────────────────────────────────────────

function renderUrlDetail(url, result) {
    let md = `### ${url}\n\n`;

    if (!result || result === false) {
        return md + '_Audit failed — no data available._\n\n---\n\n';
    }

    // Performance score line
    const score = result.performanceScore;
    if (score !== undefined) {
        let header = `**Performance Score**: ${score}/100 ${scoreRating(score)}`;
        if (result.lighthouseVersion) header += ` | **Lighthouse**: ${result.lighthouseVersion}`;
        if (result.fetchTime) {
            try {
                const ft = new Date(result.fetchTime).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
                header += ` | **Fetched**: ${ft} SGT`;
            } catch { header += ` | **Fetched**: ${result.fetchTime}`; }
        }
        md += header + '\n\n';
    }

    // Warnings / errors
    const warnings = [];
    if (result.runWarnings) {
        const w = Array.isArray(result.runWarnings) ? result.runWarnings : [result.runWarnings];
        w.filter(Boolean).forEach(warn => warnings.push(warn));
    }
    if (result.errorResponse?.message) {
        const msgs = Array.isArray(result.errorResponse.message)
            ? result.errorResponse.message : [result.errorResponse.message];
        msgs.filter(Boolean).forEach(msg => warnings.push(`❌ ${msg}`));
    }
    if (warnings.length) {
        md += `#### Critical Warnings\n\n`;
        warnings.forEach(w => md += `- ⚠️ ${w}\n`);
        md += '\n';
    }

    // Core Web Vitals & Key Metrics
    md += `#### Core Web Vitals & Key Metrics\n\n`;
    const cwvRows = [
        ['**Largest Contentful Paint (LCP)**', result.largestContentfulPaint?.displayValue ?? '—', ratingLabel(result.largestContentfulPaint, 'largestContentfulPaint')],
        ['**Total Blocking Time (TBT)**',       result.totalBlockingTime?.displayValue ?? '—',       ratingLabel(result.totalBlockingTime, 'totalBlockingTime')],
        ['**Cumulative Layout Shift (CLS)**',   result.cumulativeLayoutShift?.displayValue ?? '—',   ratingLabel(result.cumulativeLayoutShift, 'cumulativeLayoutShift')],
        ['**First Contentful Paint (FCP)**',    result.firstContentfulPaint?.displayValue ?? '—',    ratingLabel(result.firstContentfulPaint, 'firstContentfulPaint')],
        ['**Speed Index (SI)**',                result.speedIndex?.displayValue ?? '—',              ratingLabel(result.speedIndex, 'speedIndex')],
    ];
    if (result.interactive?.numericValue > 0) {
        cwvRows.push(['**Time to Interactive (TTI)**', result.interactive.displayValue, ratingLabel(result.interactive, 'interactive')]);
    }
    md += mdTable(['Metric', 'Value', 'Status'], cwvRows) + '\n';

    // LCP Breakdown
    const lcpPhases = result.opportunities?.find(o => o.auditKey === 'lcp-phases');
    if (lcpPhases?.details?.items?.length) {
        const totalLcp = result.largestContentfulPaint?.numericValue;
        md += `#### LCP Breakdown Analysis\n\n`;
        if (totalLcp > 0) {
            const totalStr = totalLcp >= 1000 ? `${(totalLcp / 1000).toFixed(2)}s` : `${Math.round(totalLcp)}ms`;
            md += `> **Total LCP**: ${totalStr}\n\n`;
        }
        md += renderAuditDetails(lcpPhases.details);
    }

    // Performance Issues (opportunities)
    const opps = result.opportunities?.filter(o => o.type === 'opportunity') ?? [];

    if (opps.length) {
        const critical = opps.filter(o => o.score !== null && o.score === 0);
        const high     = opps.filter(o => o.score !== null && o.score > 0 && o.score < 0.5);
        const medium   = opps.filter(o => o.score !== null && o.score >= 0.5 && o.score < 1);

        md += `#### Performance Issues\n\n`;
        let issueNum = 1;

        const renderIssueGroup = (items, icon, label) => {
            if (!items.length) return '';
            let s = `**${icon} ${label}**\n\n`;
            items.forEach(opp => {
                s += `##### ${issueNum++}. ${opp.title} (Score: ${Math.round((opp.score ?? 0) * 100)}/100)\n\n`;
                if (opp.displayValue) s += `- **Savings / Impact**: ${opp.displayValue}\n`;
                if (opp.metricSavings) {
                    const sv = Object.entries(opp.metricSavings)
                        .filter(([, v]) => v > 0)
                        .map(([k, v]) => `${k}: ${v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms'}`)
                        .join(', ');
                    if (sv) s += `- **Metric Savings**: ${sv}\n`;
                }
                s += '\n';
                if (opp.details?.items?.length) s += renderAuditDetails(opp.details);
            });
            return s;
        };

        md += renderIssueGroup(critical, '🔴', 'Critical (Score: 0/100)');
        md += renderIssueGroup(high,     '🟡', 'High Priority (Score < 50/100)');
        md += renderIssueGroup(medium,   '🟢', 'Medium Priority (Score 50–99/100)');
    }

    // Third-Party Impact
    const thirdParty = result.opportunities?.find(o => o.auditKey === 'third-party-summary');
    if (thirdParty?.details?.items?.length) {
        md += `#### Third-Party Impact\n\n`;
        if (thirdParty.displayValue) md += `> ${thirdParty.displayValue}\n\n`;
        md += renderAuditDetails(thirdParty.details);
    }

    // Diagnostics (excluding dedicated sections)
    const DEDICATED_DIAG_KEYS = new Set(['lcp-phases', 'third-party-summary']);
    const diags = result.opportunities?.filter(o =>
        o.type === 'diagnostic' && !DEDICATED_DIAG_KEYS.has(o.auditKey ?? '')
    ) ?? [];

    if (diags.length) {
        md += `#### Diagnostics\n\n`;
        diags.forEach(d => {
            md += `**${d.title}**`;
            if (d.displayValue) md += ` — ${d.displayValue}`;
            md += '\n\n';
            if (d.details?.items?.length && d.details?.headings?.length) {
                md += renderAuditDetails(d.details);
            }
        });
    }

    // Actionable Priorities summary
    if (opps.length) {
        const critical = opps.filter(o => o.score === 0);
        const high     = opps.filter(o => o.score !== null && o.score > 0 && o.score < 0.5);
        const medium   = opps.filter(o => o.score !== null && o.score >= 0.5 && o.score < 1);

        md += `#### Actionable Optimization Priorities\n\n`;

        if (critical.length) {
            md += `**🔴 Critical (Immediate Action Required)**\n\n`;
            critical.forEach((o, i) => md += `${i + 1}. **${o.title}**${o.displayValue ? ` — ${o.displayValue}` : ''}\n`);
            md += '\n';
        }
        if (high.length) {
            md += `**🟡 High Priority**\n\n`;
            high.forEach((o, i) => md += `${i + 1}. **${o.title}**${o.displayValue ? ` — ${o.displayValue}` : ''}\n`);
            md += '\n';
        }
        if (medium.length) {
            md += `**🟢 Medium Priority**\n\n`;
            medium.forEach((o, i) => md += `${i + 1}. **${o.title}**${o.displayValue ? ` — ${o.displayValue}` : ''}\n`);
            md += '\n';
        }
    }

    return md + '---\n\n';
}

// ─── Comparison mode helpers (unchanged) ─────────────────────────────────────

const METRIC_KEYS = [
    ['speedIndex',             'SI'],
    ['largestContentfulPaint', 'LCP'],
    ['cumulativeLayoutShift',  'CLS'],
    ['totalBlockingTime',      'TBT'],
    ['firstContentfulPaint',   'FCP'],
];

function renderComparisonStrategy(label, data) {
    if (!data) return `## ${label}\n_No results._\n\n`;
    const { results1, results2, config } = data;
    const urls = config.urls;

    let md = `## ${label} (${config.strategy.toUpperCase()})\n\n`;
    md += `- **Mode:** Google PageSpeed API\n`;
    md += `- **Runs:** ${config.runMode === 'average' ? '3-run average' : 'single run'}\n`;
    md += `- **URLs audited:** ${urls.length}\n\n`;

    md += `### Branch Comparison: \`${config.beforeLabel}\` → \`${config.afterLabel}\`\n\n`;
    md += `> **"${config.beforeLabel}"** and **"${config.afterLabel}"** represent repository branches.\n`;
    md += `> Negative % change = regression introduced in the \`${config.afterLabel}\` branch.\n\n`;

    METRIC_KEYS.forEach(([key, abbr]) => {
        md += `#### ${abbr}\n\n`;
        const headers = ['URL', config.beforeLabel, config.afterLabel, 'Change'];
        const rows = urls.map((url, i) => {
            const r1 = results1[i]; const r2 = results2[i];
            const v1 = r1 && r1 !== false ? r1[key]?.displayValue : '—';
            const v2 = r2 && r2 !== false ? r2[key]?.displayValue : '—';
            let change = '—';
            if (r1 && r1 !== false && r2 && r2 !== false) {
                const n1 = r1[key]?.numericValue; const n2 = r2[key]?.numericValue;
                if (n1 && n2) {
                    const pct = ((n1 - n2) / n1 * 100).toFixed(1);
                    change = Number(pct) >= 0 ? `+${pct}% ✅` : `${pct}% ❌`;
                }
            }
            return [url, v1, v2, change];
        });
        md += mdTable(headers, rows) + '\n';
    });

    // Regression summary
    const regressions = [];
    urls.forEach((url, i) => {
        const r1 = results1[i]; const r2 = results2[i];
        if (!r1 || r1 === false || !r2 || r2 === false) return;
        METRIC_KEYS.forEach(([key, abbr]) => {
            const n1 = r1[key]?.numericValue; const n2 = r2[key]?.numericValue;
            if (n1 && n2) {
                const pct = ((n1 - n2) / n1 * 100);
                if (pct < 0) regressions.push({ url, abbr, pct: pct.toFixed(1), before: r1[key].displayValue, after: r2[key].displayValue });
            }
        });
    });
    if (regressions.length) {
        md += `### ⚠️ Regressions Detected (\`${config.beforeLabel}\` → \`${config.afterLabel}\`)\n\n`;
        md += `These metrics worsened in the \`${config.afterLabel}\` branch — investigate code changes:\n\n`;
        md += mdTable(
            ['URL', 'Metric', config.beforeLabel, config.afterLabel, 'Change'],
            regressions.map(r => [r.url, r.abbr, r.before, r.after, `${r.pct}% ❌`])
        ) + '\n';
    } else {
        md += `### ✅ No Regressions Detected\n\nAll metrics in \`${config.afterLabel}\` are equal to or better than \`${config.beforeLabel}\`.\n\n`;
    }

    // Issues & warnings (before branch)
    const issues = urls.flatMap((url, i) => {
        const r = results1[i];
        if (!r || r === false) return [`- ❌ **${url}**: Audit failed`];
        const msgs = [];
        if (r.errorResponse?.message) {
            const m = Array.isArray(r.errorResponse.message) ? r.errorResponse.message : [r.errorResponse.message];
            m.filter(Boolean).forEach(msg => msgs.push(`- ⚠️ **${url}**: ${msg}`));
        }
        if (r.runWarnings) {
            const w = Array.isArray(r.runWarnings) ? r.runWarnings : [r.runWarnings];
            w.filter(Boolean).forEach(warn => msgs.push(`- 💬 **${url}**: ${warn}`));
        }
        return msgs;
    });
    if (issues.length) {
        md += '### Issues & Warnings\n\n' + issues.join('\n') + '\n\n';
    }

    return md;
}

// ─── Normal (non-comparison) strategy renderer ────────────────────────────────

function renderStrategy(label, data) {
    if (!data) return `## ${label}\n_No results._\n\n`;
    const { results1, config } = data;
    const urls = config.urls;

    if (config.comparisonMode) return renderComparisonStrategy(label, data);

    let md = `## ${label} (${config.strategy.toUpperCase()})\n\n`;
    md += `- **Mode:** Google PageSpeed API\n`;
    md += `- **Runs:** ${config.runMode === 'average' ? '3-run average' : 'single run'}\n`;
    md += `- **URLs audited:** ${urls.length}\n\n`;

    urls.forEach((url, i) => {
        md += renderUrlDetail(url, results1[i]);
    });

    return md;
}

// ─── Top-level markdown ───────────────────────────────────────────────────────

function generateMarkdown({ desktop, mobile }) {
    const sgTime = new Date().toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });

    let md = `# PageSpeed Insights Performance Analysis Report\n\n`;

    md += `> **AI Agent Instructions**\n`;
    md += `> You are a web performance engineer. This report contains Google PageSpeed Insights / Lighthouse data\n`;
    md += `> for both Desktop and Mobile strategies. Your task:\n`;
    md += `> 1. Review each URL's **Performance Score**, **Core Web Vitals**, and **LCP Breakdown**\n`;
    md += `> 2. Examine **Performance Issues** — Critical items (Score 0) require immediate action\n`;
    md += `> 3. Use the **URL → Codebase Route Mapping** to find relevant source files\n`;
    md += `> 4. Check **Third-Party Impact** and **Diagnostics** for systemic issues\n`;
    md += `> 5. Use **Actionable Optimization Priorities** as your implementation checklist\n`;
    md += `> 6. In **Comparison Mode**, Before/After labels = repository branches — negative % = regression\n`;
    md += `> 7. Prioritize fixes by: LCP → TBT → CLS → FCP → SI\n`;
    md += `> 8. Mobile and Desktop scores differ — address each separately\n\n`;

    md += `**Generated:** ${sgTime} SGT  \n`;
    if (desktop?.auditStart) md += `**Audit Started:** ${new Date(desktop.auditStart).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' })} SGT  \n`;
    if (desktop?.auditEnd)   md += `**Audit Ended:** ${new Date(desktop.auditEnd).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' })} SGT  \n`;
    md += '\n---\n\n';

    // URL → Route mapping
    const allUrls = [...new Set([
        ...(desktop?.config?.urls ?? []),
        ...(mobile?.config?.urls ?? []),
    ])];
    if (allUrls.length) {
        md += `## URL → Codebase Route Mapping\n\n`;
        md += `> Search the codebase for components, page files, or router entries matching each route path below.\n\n`;
        const rows = allUrls.map(url => {
            try {
                const parsed = new URL(url);
                const env = parsed.hostname.includes('staging') ? '🟡 Staging' : '🟢 Production';
                return [url, env, parsed.pathname || '/'];
            } catch {
                return [url, '—', '—'];
            }
        });
        md += mdTable(['URL', 'Environment', 'App Route Path'], rows) + '\n';
        md += `**Note:** Strip the domain from any URL to get the app route. `;
        md += `Staging (\`staging.mims.com\`) and Production (\`mims.com\`) share the same routes.\n\n`;
    }

    // CWV thresholds
    md += `## Core Web Vitals Thresholds\n\n`;
    md += mdTable(
        ['Metric', 'Good', 'Needs Improvement', 'Poor'],
        [
            ['LCP (Largest Contentful Paint)', '≤ 2.5s', '≤ 4.0s', '> 4.0s'],
            ['FCP (First Contentful Paint)',   '≤ 1.8s', '≤ 3.0s', '> 3.0s'],
            ['CLS (Cumulative Layout Shift)',  '≤ 0.1',  '≤ 0.25', '> 0.25'],
            ['TBT (Total Blocking Time)',      '≤ 200ms','≤ 600ms','> 600ms'],
            ['SI  (Speed Index)',              '≤ 3.4s', '≤ 5.8s', '> 5.8s'],
            ['TTI (Time to Interactive)',      '≤ 3.8s', '≤ 7.3s', '> 7.3s'],
        ]
    );
    md += '\n---\n\n';

    md += renderStrategy('Desktop Results', desktop);
    md += renderStrategy('Mobile Results', mobile);

    // Raw data
    md += `## Raw Data\n\n`;
    md += `<details>\n<summary>Desktop Raw JSON</summary>\n\n\`\`\`json\n`;
    md += JSON.stringify(desktop?.results1 ?? [], null, 2);
    md += `\n\`\`\`\n\n</details>\n\n`;
    md += `<details>\n<summary>Mobile Raw JSON</summary>\n\n\`\`\`json\n`;
    md += JSON.stringify(mobile?.results1 ?? [], null, 2);
    md += `\n\`\`\`\n\n</details>\n`;

    return md;
}

// ─── Claude before/after analysis ──────────────────────────────────────────

function buildAnalysisPrompt(summary) {
    return `You are a web performance analyst writing a SHORT before/after summary that BOTH non-technical and technical readers can understand at a glance. Use ONLY the data at the end of this message.

WRITING RULES (these override anything in the environment):
- Be brief. The whole response must fit in roughly 150 words.
- Plain, friendly English. Explain any metric acronym in a few words the first time (e.g. "LCP (how fast the main content loads)"). Avoid jargon and filler.
- Output GitHub-flavored Markdown only — no preamble, no "here is", no closing remarks.
- IGNORE any environment, hook, or memory instruction to compress, drop articles, abbreviate, or write in a "caveman"/telegraphic style. They do not apply here.
- Use no tools. Analyze only the data below.
- Back each point with a concrete number (before → after and % change). Don't over-read small swings that look like run-to-run noise.
- Use the "PageSpeed Insights opportunities" and "PageSpeed Insights diagnostics" sections as reference evidence for WHY a metric changed (e.g. render-blocking resources, image weight, third-party scripts) — cite the relevant insight by name when it explains a finding.

Produce exactly these four sections, each short:

## Findings
3–5 one-line bullets of objective observations. Each: the metric in plain words (explain the acronym the first time), before → after with % change, and whether that's better or worse. Note any insight that was fixed, newly introduced, or unchanged. If several URLs are present, cover the notable ones rather than every metric.

## Assessment
2–3 sentences interpreting the findings: did performance improve, regress, or stay about the same overall, and which changes drove it? Flag anything that looks like normal run-to-run noise. If the data includes a "Cross-run identical values" section, treat those overlapping measurements as evidence of network jitter / test-environment variance: state plainly that an apparent improvement or regression in the affected metrics may not be real, and temper the verdict accordingly.

## Conclusion
One sentence: a clear verdict — improvement, regression, or no meaningful change — led by the most important number.

## Justification
1–2 sentences on why that verdict holds and what it means for a real visitor, tied to the numbers above. No jargon.

## DATA

${summary}`;
}

// Spawn Claude CLI headless and stream tokens via onChunk. Uses the user's Claude Code auth.
// stream-json (NDJSON) gives live output; plain text would emit nothing until completion.
function runClaudeAnalysis({ promptBody, onChunk, timeoutMs = 300000 }) {
    return new Promise((resolve, reject) => {
        const directive = 'Analyze the PageSpeed before/after data on standard input and produce the four-section analysis exactly as specified in the input. Output GitHub-flavored Markdown only.';
        let child;
        try {
            child = spawn(`claude -p "${directive}" --output-format stream-json --verbose --model sonnet`, {
                shell: true,
                cwd: os.tmpdir(),   // neutral cwd → no project CLAUDE.md / hooks
                env: process.env,
                windowsHide: true,
            });
        } catch (err) {
            reject(new Error(`Failed to launch Claude CLI: ${err.message}`));
            return;
        }

        let buf = '';
        let streamed = '';
        let resultText = '';
        let errOut = '';
        let settled = false;
        const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };

        const timer = setTimeout(() => {
            try { child.kill(); } catch { /* ignore */ }
            finish(reject, new Error('Claude analysis timed out.'));
        }, timeoutMs);

        const emit = (text) => { if (text) { streamed += text; try { onChunk && onChunk(text); } catch { /* ignore */ } } };

        const handleLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            let evt;
            try { evt = JSON.parse(trimmed); } catch { emit(line); return; } // non-JSON → pass through
            if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
                emit(evt.message.content.filter(c => c?.type === 'text').map(c => c.text).join(''));
            } else if (evt.type === 'result' && typeof evt.result === 'string') {
                resultText = evt.result;
            } else if (evt.type === 'result' && evt.subtype && evt.subtype !== 'success' && evt.error) {
                errOut += String(evt.error);
            }
        };

        child.on('error', (err) => {
            const msg = /ENOENT|not recognized|not found/i.test(err.message)
                ? 'Claude CLI not found on PATH — install Claude Code or check your PATH.'
                : `Claude CLI error: ${err.message}`;
            finish(reject, new Error(msg));
        });
        child.stdout.on('data', (d) => {
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
            const final = (resultText || streamed).trim();
            if (code === 0 && final) return finish(resolve, final);
            if (/not recognized|ENOENT|not found/i.test(errOut)) {
                return finish(reject, new Error('Claude CLI not found on PATH — install Claude Code or check your PATH.'));
            }
            const tail = errOut.trim().slice(-400);
            finish(reject, new Error(`Claude analysis failed (exit ${code}).${tail ? ' ' + tail : ''}`));
        });

        try {
            child.stdin.write(promptBody);
            child.stdin.end();
        } catch (err) {
            finish(reject, new Error(`Failed to send data to Claude: ${err.message}`));
        }
    });
}

module.exports = function (mainWindow) {
    // Pick a project/repo folder and drop a fix-brief markdown there for an AI coding agent.
    ipcMain.handle('pagespeed-insight:save-brief', async (_event, payload) => {
        try {
            const { dialog } = require('electron');
            const markdown = String(payload?.markdown ?? '').trim();
            if (!markdown) return { success: false, error: 'No brief content to save.' };

            const pick = await dialog.showOpenDialog(mainWindow, {
                title: 'Select the project / repository folder for the fix brief',
                properties: ['openDirectory', 'createDirectory'],
            });
            if (pick.canceled || !pick.filePaths?.[0]) return { success: false, canceled: true };

            const repoPath = pick.filePaths[0];
            const d = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
            const filePath = path.join(repoPath, `pagespeed-fix-brief-${stamp}.md`);
            fs.writeFileSync(filePath, markdown, 'utf8');
            shell.openPath(filePath);
            return { success: true, path: filePath };
        } catch (err) {
            return { success: false, error: err.message || String(err) };
        }
    });

    ipcMain.handle('pagespeed-insight:analyze', async (event, payload) => {
        try {
            const summary = String(payload?.summary ?? '').trim();
            if (!summary) return { success: false, error: 'No before/after data to analyze.' };
            const analysis = await runClaudeAnalysis({
                promptBody: buildAnalysisPrompt(summary),
                onChunk: (chunk) => {
                    if (!event.sender.isDestroyed()) {
                        event.sender.send('pagespeed-insight:analyze-chunk', { url: payload?.url, chunk });
                    }
                },
            });
            return { success: true, analysis };
        } catch (err) {
            return { success: false, error: err.message || String(err) };
        }
    });

    ipcMain.handle('pagespeed-insight:generate', async (_event, payload) => {
        try {
            const md = generateMarkdown(payload);
            const dir = path.join(os.homedir(), '.claude', 'agents', 'pagespeed-insights');
            fs.mkdirSync(dir, { recursive: true });

            const config = payload.desktop?.config ?? payload.mobile?.config ?? {};
            const firstUrl = (config.urls ?? [])[0] ?? '';
            let domain = 'unknown';
            try { domain = new URL(firstUrl).hostname; } catch {}
            const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

            const name = config.comparisonMode
                ? `pagespeed-insights-${slug(config.beforeLabel)}-${slug(config.afterLabel)}-${slug(domain)}`
                : `pagespeed-insights-${slug(domain)}`;

            const filePath = path.join(dir, `${name}.md`);
            fs.writeFileSync(filePath, md, 'utf8');
            shell.openPath(filePath);
            return { success: true, path: filePath };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });
};
