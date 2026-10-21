'use strict';

// Ask Telemetry: a plain-English question becomes one KQL query against an app's
// Application Insights, written by the Claude CLI and run here, read-only.
//
// Only the question, the table schema and (on a repair) the query error ever reach
// Claude. Telemetry rows stay on this machine: they go from the App Insights API
// straight to the renderer.

const os = require('os');
const { runClaudeCli, killTree, leanFlags } = require('./claude-cli.cjs');

const AI_SCOPE = 'https://api.applicationinsights.io/.default';
const ARM_SCOPE = 'https://management.azure.com/.default';

/** Rows handed to the renderer. The query asks for one more, so a cut-off result is detectable. */
const MAX_ROWS = 5000;
const QUERY_TIMEOUT_MS = 60_000;
const CLAUDE_TIMEOUT_MS = 120_000;

// The App Insights tables a question is realistically about. The metadata endpoint
// also lists empty or internal tables; leaving them out keeps the prompt small and
// stops the model reaching for a table the app never writes to.
const STANDARD_TABLES = [
  'requests', 'dependencies', 'exceptions', 'traces', 'pageViews', 'browserTimings',
  'customEvents', 'customMetrics', 'availabilityResults', 'performanceCounters',
];

// Used when the metadata call fails, so a question still gets a grounded answer.
const COMMON = [
  ['timestamp', 'datetime'], ['operation_Name', 'string'], ['operation_Id', 'string'],
  ['cloud_RoleName', 'string'], ['cloud_RoleInstance', 'string'], ['client_Type', 'string'],
  ['customDimensions', 'dynamic'], ['itemCount', 'int'],
];
const FALLBACK_SCHEMA = [
  { name: 'requests', columns: [...COMMON, ['name', 'string'], ['url', 'string'], ['resultCode', 'string'], ['success', 'bool'], ['duration', 'real'], ['performanceBucket', 'string']] },
  { name: 'dependencies', columns: [...COMMON, ['name', 'string'], ['target', 'string'], ['type', 'string'], ['data', 'string'], ['resultCode', 'string'], ['success', 'bool'], ['duration', 'real']] },
  { name: 'exceptions', columns: [...COMMON, ['type', 'string'], ['outerMessage', 'string'], ['outerType', 'string'], ['problemId', 'string'], ['severityLevel', 'int']] },
  { name: 'traces', columns: [...COMMON, ['message', 'string'], ['severityLevel', 'int']] },
  { name: 'pageViews', columns: [...COMMON, ['name', 'string'], ['url', 'string'], ['duration', 'real'], ['client_Browser', 'string'], ['client_CountryOrRegion', 'string']] },
].map(t => ({ name: t.name, columns: t.columns.map(([name, type]) => ({ name, type })) }));

// ─── Schema ──────────────────────────────────────────────────────────────────

/** The standard tables from a `/metadata` response, with column names and types. */
function slimSchema(metadata) {
  const tables = Array.isArray(metadata?.tables) ? metadata.tables : [];
  const byName = new Map(tables.map(t => [String(t?.name ?? ''), t]));
  return STANDARD_TABLES
    .map(name => byName.get(name))
    .filter(t => t && Array.isArray(t.columns) && t.columns.length)
    .map(t => ({
      name: t.name,
      columns: t.columns
        .filter(c => c?.name)
        .map(c => ({ name: String(c.name), type: String(c.type ?? 'string') })),
    }));
}

async function fetchSchema(appId, token, signal) {
  try {
    const res = await fetch(`https://api.applicationinsights.io/v1/apps/${appId}/metadata`, {
      headers: { Authorization: `Bearer ${token}`, 'x-ms-app': 'devforge' },
      signal,
    });
    if (!res.ok) return { schema: FALLBACK_SCHEMA, fallback: true };
    const schema = slimSchema(await res.json());
    return schema.length ? { schema, fallback: false } : { schema: FALLBACK_SCHEMA, fallback: true };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { schema: FALLBACK_SCHEMA, fallback: true };
  }
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

/** A bin size that gives roughly 60–300 points over the range. */
function suggestBin(startIso, endIso) {
  const hours = (new Date(endIso) - new Date(startIso)) / 3_600_000;
  if (!(hours > 0)) return '5m';
  if (hours <= 2) return '1m';
  if (hours <= 12) return '5m';
  if (hours <= 48) return '15m';
  if (hours <= 24 * 7) return '1h';
  return '6h';
}

function formatSchema(schema) {
  return schema
    .map(t => `${t.name}: ${t.columns.map(c => `${c.name}:${c.type}`).join(', ')}`)
    .join('\n');
}

function buildKqlPrompt({ question, schema, startIso, endIso, previousKql, error }) {
  const repair = previousKql
    ? `

## PREVIOUS ATTEMPT FAILED
This query was rejected:
${previousKql}

Error returned:
${String(error ?? '').slice(0, 1500)}

Fix the query. Keep answering the same question.`
    : '';

  return `You write Kusto (KQL) queries for Azure Application Insights.

Return ONE JSON object and nothing else. No prose, no markdown fences. Shape:
{"kql": "<query>", "explanation": "<one sentence, plain English, what the query shows>", "chart": {"type": "timeseries" | "bar" | "table", "x": "<column>", "y": ["<numeric column>", ...], "series": "<optional string column that splits lines>"}}

Rules:
- Use only the tables and columns listed under SCHEMA. Never invent a column.
- The time range (${startIso} to ${endIso}) is applied by the API. Do NOT filter on timestamp with ago() or datetime literals.
- For a trend over time, summarize by bin(timestamp, ${suggestBin(startIso, endIso)}) and order by timestamp asc; chart type "timeseries", x "timestamp".
- To split a trend by a category, keep it long format (timestamp, category, value) and name the category in "series". Keep the top categories only (at most 8).
- For a ranking or breakdown, summarize by the category, order by the value desc and take at most 20; chart type "bar".
- Use "table" for raw rows or anything that does not chart.
- Name computed columns clearly (P95Ms, Failures, FailureRatePct). duration is in milliseconds.
- Remember itemCount when counting sampled telemetry: sum(itemCount) rather than count().
- Read-only queries only. No control commands, no render operator.

## SCHEMA
${formatSchema(schema)}

## QUESTION
${String(question).trim()}${repair}`;
}

// ─── Response parsing / guarding ─────────────────────────────────────────────

const CHART_TYPES = new Set(['timeseries', 'bar', 'table']);

function parseKqlResponse(text) {
  const cleaned = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude did not return a query.');
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { throw new Error('Claude returned malformed JSON.'); }
  const kql = typeof parsed.kql === 'string' ? parsed.kql.trim() : '';
  if (!kql) throw new Error('Claude did not return a query.');

  const c = parsed.chart && typeof parsed.chart === 'object' ? parsed.chart : {};
  const chart = { type: CHART_TYPES.has(c.type) ? c.type : 'table' };
  if (typeof c.x === 'string' && c.x) chart.x = c.x;
  if (Array.isArray(c.y)) chart.y = c.y.filter(v => typeof v === 'string' && v);
  if (typeof c.series === 'string' && c.series) chart.series = c.series;

  return {
    kql,
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation.trim() : '',
    chart,
  };
}

/** Split on top-level `;`, ignoring ones inside string literals and comments. */
function splitStatements(kql) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < kql.length; i++) {
    const ch = kql[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += kql[++i] ?? ''; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && kql[i + 1] === '/') {
      const nl = kql.indexOf('\n', i);
      const end = nl === -1 ? kql.length : nl;
      cur += kql.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ';') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

/**
 * Make a query safe to run unattended: no control commands, no render (the page
 * draws its own chart), and a row cap on the final statement so one careless
 * `requests` scan can't pull half a million rows into the renderer.
 */
function guardKql(kql) {
  const statements = splitStatements(String(kql ?? ''));
  if (!statements.length) throw new Error('The query is empty.');
  if (statements.some(s => s.startsWith('.'))) {
    throw new Error('Control commands are not allowed — only read-only queries run here.');
  }
  let last = statements.pop().replace(/\|\s*render\b[\s\S]*$/i, '').trim();
  if (!last) throw new Error('The query is empty.');
  if (!/\|\s*(take|limit|top)\s+\d+[^|]*$/i.test(last)) last = `${last}\n| take ${MAX_ROWS + 1}`;
  return [...statements, last].join(';\n');
}

// ─── Running ─────────────────────────────────────────────────────────────────

/**
 * One query against App Insights. Unlike makeRunQuery in azure-metrics.cjs this keeps
 * the column types — the renderer needs them to pick a chart.
 */
async function runKql({ appId, token, kql, startIso, endIso, signal, timeoutMs = QUERY_TIMEOUT_MS }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`https://api.applicationinsights.io/v1/apps/${appId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-ms-app': 'devforge' },
      body: JSON.stringify({ query: kql, timespan: `${startIso}/${endIso}` }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { error: `${res.status}: ${readApiError(body)}` };
    }
    const data = await res.json();
    if (data.error) return { error: data.error.message || JSON.stringify(data.error) };
    const table = data.tables?.[0];
    const rows = Array.isArray(table?.rows) ? table.rows : [];
    return {
      columns: (table?.columns ?? []).map(c => ({ name: String(c.name), type: String(c.type ?? 'string') })),
      rows: rows.slice(0, MAX_ROWS),
      truncated: rows.length > MAX_ROWS,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    if (timedOut) return { error: `Query timed out after ${Math.round(timeoutMs / 1000)}s.` };
    if (controller.signal.aborted) return { error: 'Cancelled.', cancelled: true };
    return { error: e.message };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** The API wraps a syntax error in nested JSON; the innermost message is the useful one. */
function readApiError(body) {
  try {
    let err = JSON.parse(body)?.error;
    const parts = [];
    while (err) {
      if (err.message) parts.push(err.message);
      err = err.innererror;
    }
    if (parts.length) return parts.join(' — ');
  } catch { /* not JSON */ }
  return String(body).slice(0, 1000);
}

/** Running cost of the Claude calls; a call that reported no usage still counts. */
function addMeta(a, b = {}) {
  const tokens = (k) => (a.tokens?.[k] ?? 0) + (b.tokens?.[k] ?? 0);
  return {
    costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
    tokens: { input: tokens('input'), output: tokens('output'), total: tokens('total') },
    calls: (a.calls ?? 0) + 1,
  };
}

/**
 * Question → KQL → result, with one automatic repair when the first query is
 * rejected. Claude and the query runner are injected so the flow is testable.
 *
 * @param {object} o
 * @param {(promptBody: string) => Promise<{ text: string, meta?: object }>} o.generate
 * @param {(kql: string) => Promise<object>} o.run
 * @param {(stage: string) => void} [o.onStage]
 */
async function askFlow({ question, schema, startIso, endIso, generate, run, onStage = () => {} }) {
  let meta = { costUsd: 0, tokens: { input: 0, output: 0, total: 0 }, calls: 0 };

  onStage('generating');
  const first = await generate(buildKqlPrompt({ question, schema, startIso, endIso }));
  meta = addMeta(meta, first.meta);
  let answer = parseKqlResponse(first.text);

  // The page shows the query as Claude wrote it; the guarded copy (row cap added)
  // is what runs, and what a repair is asked about, since the error refers to it.
  const attempt = async (kql) => {
    let guarded;
    try { guarded = guardKql(kql); } catch (e) { return { kql, ran: kql, result: { error: e.message } }; }
    onStage('running');
    return { kql, ran: guarded, result: await run(guarded) };
  };

  let { kql, ran, result } = await attempt(answer.kql);
  let repaired = false;
  if (result.error && !result.cancelled) {
    onStage('repairing');
    const second = await generate(buildKqlPrompt({ question, schema, startIso, endIso, previousKql: ran, error: result.error }));
    meta = addMeta(meta, second.meta);
    let fixed = null;
    try { fixed = parseKqlResponse(second.text); } catch { /* keep the first attempt and its error */ }
    if (fixed) {
      const retry = await attempt(fixed.kql);
      // A repair that fails too is not better than the original: show the first
      // query and its error, which is what the user can act on.
      if (!retry.result.error || retry.result.cancelled) {
        answer = fixed;
        ({ kql, result } = retry);
        repaired = !retry.result.error;
      }
    }
  }

  return { kql, explanation: answer.explanation, chart: answer.chart, result, repaired, meta };
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

// Sonnet over Haiku, measured 2026-10-21: Haiku wrote 4-14x more output (thinking),
// was slower and no cheaper. leanFlags keeps the call at ~2k tokens of the plan.
const CLAUDE_FLAGS = [
  '--output-format stream-json',
  '--verbose',
  '--model sonnet',
  ...leanFlags('You write Kusto KQL queries for Azure Application Insights. Follow the instructions on standard input exactly and reply with one JSON object only.'),
];

const handler = (_mainWindow) => {
  const { ipcMain } = require('electron');
  const { DefaultAzureCredential } = require('@azure/identity');
  const azureMetrics = require('./azure-metrics.cjs');

  let cred = null;
  const credential = () => cred ?? (cred = azureMetrics._createCachingCredential(new DefaultAzureCredential()));
  const getToken = async (scope) => {
    try {
      return (await credential().getToken(scope)).token;
    } catch (e) {
      cred = null; // a fresh `az login` should work on the next try
      throw new Error(`Azure sign-in failed — run \`az login\`. (${e.message})`);
    }
  };

  const appIds = new Map();
  const schemas = new Map();

  async function resolveAppId(config, appKey, target) {
    const app = config?.apps?.find(a => a.name === appKey);
    if (!app) throw new Error(`App "${appKey}" is not configured.`);
    const name = target === 'api' ? app.apiName : app.name;
    if (target === 'api' && !name) throw new Error(`${app.platformName || app.name} has no API configured.`);
    const configured = target === 'api' ? app.apiInsightsAppId : app.appInsightsAppId;
    if (configured) return configured;

    const key = `${config.subscriptionId}/${app.resourceGroup}/${name}`;
    if (!appIds.has(key)) {
      const armToken = await getToken(ARM_SCOPE);
      const found = await azureMetrics._findAppInsightsAppId(armToken, config.subscriptionId, app.resourceGroup, name);
      if (found) appIds.set(key, found);
    }
    const id = appIds.get(key);
    if (!id) throw new Error(`No Application Insights found for ${name}. Add its App ID in Settings → Azure.`);
    return id;
  }

  // One run at a time: a new question cancels the previous one.
  let current = null;
  const cancelCurrent = () => {
    if (!current) return false;
    current.handle.cancelled = true;
    killTree(current.handle.child);
    current.abort.abort();
    current = null;
    return true;
  };

  const begin = () => {
    cancelCurrent();
    const run = { handle: { child: null, cancelled: false }, abort: new AbortController() };
    current = run;
    return run;
  };
  const end = (run) => { if (current === run) current = null; };

  ipcMain.handle('telemetry:ask', async (event, { config, appKey, target, question, startIso, endIso }) => {
    if (!String(question ?? '').trim()) return { success: false, error: 'Ask a question first.' };
    const run = begin();
    const stage = (s) => { if (!event.sender.isDestroyed()) event.sender.send('telemetry:progress', { stage: s }); };
    try {
      stage('schema');
      const appId = await resolveAppId(config, appKey, target);
      const token = await getToken(AI_SCOPE);
      let schema = schemas.get(appId);
      if (!schema) {
        const fetched = await fetchSchema(appId, token, run.abort.signal);
        schema = fetched.schema;
        // The built-in fallback still answers this question; only a real schema is
        // cached, so the next question tries the metadata endpoint again.
        if (!fetched.fallback) schemas.set(appId, schema);
      }
      const out = await askFlow({
        question,
        schema,
        startIso,
        endIso,
        onStage: stage,
        generate: (promptBody) => runClaudeCli({
          directive: 'Write one Kusto query for the Application Insights question on standard input. Reply with the JSON object only.',
          promptBody,
          cwd: os.tmpdir(), // neutral cwd: no project CLAUDE.md or hooks
          timeoutMs: CLAUDE_TIMEOUT_MS,
          flags: CLAUDE_FLAGS,
          handle: run.handle,
        }),
        run: (kql) => runKql({ appId, token, kql, startIso, endIso, signal: run.abort.signal }),
      });
      if (out.result.cancelled || run.handle.cancelled) return { success: false, cancelled: true };
      return { success: true, ...out };
    } catch (e) {
      if (e?.code === 'CANCELLED' || run.handle.cancelled) return { success: false, cancelled: true };
      return { success: false, error: e.message };
    } finally {
      end(run);
    }
  });

  ipcMain.handle('telemetry:run', async (_event, { config, appKey, target, kql, startIso, endIso }) => {
    const run = begin();
    try {
      const appId = await resolveAppId(config, appKey, target);
      const token = await getToken(AI_SCOPE);
      const result = await runKql({ appId, token, kql: guardKql(kql), startIso, endIso, signal: run.abort.signal });
      if (result.cancelled) return { success: false, cancelled: true };
      return { success: true, kql, result };
    } catch (e) {
      return { success: false, error: e.message };
    } finally {
      end(run);
    }
  });

  ipcMain.handle('telemetry:cancel', () => ({ success: true, running: cancelCurrent() }));
};

module.exports = handler;
Object.assign(module.exports, {
  slimSchema, fetchSchema, suggestBin, buildKqlPrompt, parseKqlResponse, splitStatements, guardKql,
  runKql, readApiError, askFlow, FALLBACK_SCHEMA, MAX_ROWS, CLAUDE_FLAGS,
});
