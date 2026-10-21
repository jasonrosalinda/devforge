import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  slimSchema, fetchSchema, suggestBin, buildKqlPrompt, parseKqlResponse, splitStatements, guardKql,
  runKql, readApiError, askFlow, FALLBACK_SCHEMA, MAX_ROWS, CLAUDE_FLAGS,
} = require('./telemetry-ask.cjs');

const START = '2026-10-20T00:00:00.000Z';
const END = '2026-10-21T00:00:00.000Z';
const SCHEMA = [{ name: 'requests', columns: [{ name: 'timestamp', type: 'datetime' }, { name: 'duration', type: 'real' }] }];

const jsonResponse = (body, init = {}) => ({
  ok: init.ok ?? true,
  status: init.status ?? 200,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('slimSchema', () => {
  it('keeps the standard tables in a fixed order with name and type', () => {
    const schema = slimSchema({
      tables: [
        { name: 'exceptions', columns: [{ name: 'type', type: 'string' }] },
        { name: 'requests', columns: [{ name: 'duration', type: 'real' }, { name: 'url' }] },
        { name: 'internalThing', columns: [{ name: 'x', type: 'string' }] },
      ],
    });
    expect(schema).toEqual([
      { name: 'requests', columns: [{ name: 'duration', type: 'real' }, { name: 'url', type: 'string' }] },
      { name: 'exceptions', columns: [{ name: 'type', type: 'string' }] },
    ]);
  });

  it('drops tables without columns and copes with a missing payload', () => {
    expect(slimSchema({ tables: [{ name: 'requests', columns: [] }] })).toEqual([]);
    expect(slimSchema(undefined)).toEqual([]);
  });
});

describe('fetchSchema', () => {
  it('returns the slimmed schema from the metadata endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ tables: [{ name: 'traces', columns: [{ name: 'message', type: 'string' }] }] }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchSchema('app-1', 'tok');
    expect(out.fallback).toBe(false);
    expect(out.schema[0].name).toBe('traces');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.applicationinsights.io/v1/apps/app-1/metadata');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('falls back to the built-in schema on an HTTP error, a network error or an empty result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('nope', { ok: false, status: 403 })));
    expect(await fetchSchema('a', 't')).toEqual({ schema: FALLBACK_SCHEMA, fallback: true });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await fetchSchema('a', 't')).toEqual({ schema: FALLBACK_SCHEMA, fallback: true });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ tables: [] })));
    expect((await fetchSchema('a', 't')).fallback).toBe(true);
  });

  it('rethrows when the caller cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('aborted'); }));
    await expect(fetchSchema('a', 't', controller.signal)).rejects.toThrow('aborted');
  });
});

describe('suggestBin', () => {
  it.each([
    ['2026-10-20T00:00:00Z', '2026-10-20T01:00:00Z', '1m'],
    ['2026-10-20T00:00:00Z', '2026-10-20T06:00:00Z', '5m'],
    ['2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', '15m'],
    ['2026-10-14T00:00:00Z', '2026-10-21T00:00:00Z', '1h'],
    ['2026-09-01T00:00:00Z', '2026-10-21T00:00:00Z', '6h'],
    ['bad', 'worse', '5m'],
  ])('%s → %s gives %s', (start, end, bin) => {
    expect(suggestBin(start, end)).toBe(bin);
  });
});

describe('buildKqlPrompt', () => {
  it('carries the schema, range, bin size and question', () => {
    const prompt = buildKqlPrompt({ question: '  slowest endpoints  ', schema: SCHEMA, startIso: START, endIso: END });
    expect(prompt).toContain('requests: timestamp:datetime, duration:real');
    expect(prompt).toContain(`${START} to ${END}`);
    expect(prompt).toContain('bin(timestamp, 15m)');
    expect(prompt).toMatch(/## QUESTION\nslowest endpoints$/);
    expect(prompt).not.toContain('PREVIOUS ATTEMPT');
  });

  it('adds the failed query and its error for a repair', () => {
    const prompt = buildKqlPrompt({
      question: 'q', schema: SCHEMA, startIso: START, endIso: END,
      previousKql: 'requests | bad', error: "Failed to resolve column 'bad'",
    });
    expect(prompt).toContain('## PREVIOUS ATTEMPT FAILED');
    expect(prompt).toContain('requests | bad');
    expect(prompt).toContain("Failed to resolve column 'bad'");
  });
});

describe('parseKqlResponse', () => {
  it('reads a fenced reply with a preamble', () => {
    const out = parseKqlResponse('Here you go:\n```json\n{"kql":" requests | count ","explanation":" Counts. ","chart":{"type":"bar","x":"name","y":["n", 3],"series":"s"}}\n```');
    expect(out).toEqual({ kql: 'requests | count', explanation: 'Counts.', chart: { type: 'bar', x: 'name', y: ['n'], series: 's' } });
  });

  it('defaults an unknown or missing chart to a table', () => {
    expect(parseKqlResponse('{"kql":"requests","chart":{"type":"pie"}}').chart).toEqual({ type: 'table' });
    expect(parseKqlResponse('{"kql":"requests"}')).toEqual({ kql: 'requests', explanation: '', chart: { type: 'table' } });
  });

  it('rejects replies without a query', () => {
    expect(() => parseKqlResponse('I cannot help')).toThrow('did not return a query');
    expect(() => parseKqlResponse('{"kql": ""}')).toThrow('did not return a query');
    expect(() => parseKqlResponse('{"kql": nope}')).toThrow('malformed JSON');
    expect(() => parseKqlResponse(null)).toThrow('did not return a query');
  });
});

describe('splitStatements', () => {
  it('splits on top-level semicolons only', () => {
    expect(splitStatements('let a = "x;y";\nlet b = \'1;2\';\nrequests // c;d\n| take 1;')).toEqual([
      'let a = "x;y"', "let b = '1;2'", 'requests // c;d\n| take 1',
    ]);
  });

  it('keeps escaped quotes inside a string', () => {
    expect(splitStatements('print "a\\";b"; requests')).toEqual(['print "a\\";b"', 'requests']);
  });
});

describe('guardKql', () => {
  it('appends a row cap when the last statement has none', () => {
    expect(guardKql('requests | summarize count() by name')).toBe(`requests | summarize count() by name\n| take ${MAX_ROWS + 1}`);
  });

  it('keeps an existing take, limit or top', () => {
    expect(guardKql('requests | take 10')).toBe('requests | take 10');
    expect(guardKql('requests | limit 5')).toBe('requests | limit 5');
    expect(guardKql('requests | top 10 by duration desc')).toBe('requests | top 10 by duration desc');
  });

  it('strips render and keeps let statements', () => {
    expect(guardKql('let x = 1;\nrequests | take 3 | render timechart')).toBe('let x = 1;\nrequests | take 3');
  });

  it('rejects control commands and empty queries', () => {
    expect(() => guardKql('.show tables')).toThrow('Control commands');
    expect(() => guardKql('let x = 1;\n.drop table requests')).toThrow('Control commands');
    expect(() => guardKql('  ;  ')).toThrow('empty');
    expect(() => guardKql('| render timechart')).toThrow('empty');
    expect(() => guardKql(undefined)).toThrow('empty');
  });
});

describe('readApiError', () => {
  it('joins the nested error messages', () => {
    const body = JSON.stringify({ error: { message: 'Bad request', innererror: { message: "Failed to resolve 'x'" } } });
    expect(readApiError(body)).toBe("Bad request — Failed to resolve 'x'");
  });

  it('falls back to the raw body', () => {
    expect(readApiError('gateway timeout')).toBe('gateway timeout');
    expect(readApiError('{}')).toBe('{}');
  });
});

describe('runKql', () => {
  const args = { appId: 'app-1', token: 'tok', kql: 'requests', startIso: START, endIso: END };

  it('posts the query with the range and keeps column types', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      tables: [{ columns: [{ name: 'timestamp', type: 'datetime' }, { name: 'n', type: 'long' }], rows: [['t1', 1]] }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await runKql(args);
    expect(out.columns).toEqual([{ name: 'timestamp', type: 'datetime' }, { name: 'n', type: 'long' }]);
    expect(out.rows).toEqual([['t1', 1]]);
    expect(out.truncated).toBe(false);
    expect(typeof out.durationMs).toBe('number');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.applicationinsights.io/v1/apps/app-1/query');
    expect(JSON.parse(init.body)).toEqual({ query: 'requests', timespan: `${START}/${END}` });
  });

  it('cuts the rows at the cap and flags it', async () => {
    const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => [i]);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ tables: [{ columns: [{ name: 'i' }], rows }] })));
    const out = await runKql(args);
    expect(out.rows).toHaveLength(MAX_ROWS);
    expect(out.truncated).toBe(true);
    expect(out.columns).toEqual([{ name: 'i', type: 'string' }]);
  });

  it('turns an HTTP error into the API message', async () => {
    const body = JSON.stringify({ error: { message: 'Bad query', innererror: { message: 'Syntax error' } } });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(body, { ok: false, status: 400 })));
    expect(await runKql(args)).toEqual({ error: '400: Bad query — Syntax error' });
  });

  it('reports an error in a 200 body and an empty result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'Partial failure' } })));
    expect(await runKql(args)).toEqual({ error: 'Partial failure' });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ tables: [] })));
    expect((await runKql(args)).rows).toEqual([]);
  });

  it('times out', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })));
    expect(await runKql({ ...args, timeoutMs: 10 })).toEqual({ error: 'Query timed out after 0s.' });
  });

  it('reports a cancel from the caller, including one before the call', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_, reject) => {
      if (init.signal.aborted) reject(new Error('aborted'));
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })));
    const controller = new AbortController();
    const pending = runKql({ ...args, signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ error: 'Cancelled.', cancelled: true });
    expect(await runKql({ ...args, signal: controller.signal })).toEqual({ error: 'Cancelled.', cancelled: true });
  });

  it('passes a network error through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND'); }));
    expect(await runKql(args)).toEqual({ error: 'ENOTFOUND' });
  });
});

describe('askFlow', () => {
  const reply = (kql, extra = {}) => ({
    text: JSON.stringify({ kql, explanation: 'Shows it.', chart: { type: 'timeseries', x: 'timestamp' }, ...extra }),
    meta: { costUsd: 0.01, tokens: { input: 100, output: 20, total: 120 } },
  });
  const ok = { columns: [{ name: 'n', type: 'long' }], rows: [[1]] };
  const base = { question: 'q', schema: SCHEMA, startIso: START, endIso: END };

  it('generates, guards and runs the query', async () => {
    const generate = vi.fn(async () => reply('requests | count'));
    const run = vi.fn(async () => ok);
    const stages = [];
    const out = await askFlow({ ...base, generate, run, onStage: s => stages.push(s) });
    expect(run).toHaveBeenCalledWith(`requests | count\n| take ${MAX_ROWS + 1}`);
    expect(out).toEqual({
      kql: 'requests | count',
      explanation: 'Shows it.',
      chart: { type: 'timeseries', x: 'timestamp' },
      result: ok,
      repaired: false,
      meta: { costUsd: 0.01, tokens: { input: 100, output: 20, total: 120 }, calls: 1 },
    });
    expect(stages).toEqual(['generating', 'running']);
  });

  it('repairs a rejected query once and reports it', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(reply('requests | bad'))
      .mockResolvedValueOnce(reply('requests | good'));
    const run = vi.fn()
      .mockResolvedValueOnce({ error: "Failed to resolve 'bad'" })
      .mockResolvedValueOnce(ok);
    const stages = [];
    const out = await askFlow({ ...base, generate, run, onStage: s => stages.push(s) });
    expect(out.kql).toBe('requests | good');
    expect(out.repaired).toBe(true);
    expect(out.result).toBe(ok);
    expect(out.meta.calls).toBe(2);
    expect(out.meta.costUsd).toBeCloseTo(0.02);
    expect(stages).toEqual(['generating', 'running', 'repairing', 'running']);
    const repairPrompt = generate.mock.calls[1][0];
    expect(repairPrompt).toContain(`requests | bad\n| take ${MAX_ROWS + 1}`);
    expect(repairPrompt).toContain("Failed to resolve 'bad'");
  });

  it('repairs a query the guard refused', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(reply('.show tables'))
      .mockResolvedValueOnce(reply('requests | take 1'));
    const run = vi.fn(async () => ok);
    const out = await askFlow({ ...base, generate, run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(out.repaired).toBe(true);
    expect(out.kql).toBe('requests | take 1');
  });

  it('keeps the first query and its error when the repair fails too', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(reply('requests | bad'))
      .mockResolvedValueOnce(reply('requests | worse'));
    const run = vi.fn()
      .mockResolvedValueOnce({ error: 'first error' })
      .mockResolvedValueOnce({ error: 'second error' });
    const out = await askFlow({ ...base, generate, run });
    expect(out.kql).toBe('requests | bad');
    expect(out.result).toEqual({ error: 'first error' });
    expect(out.repaired).toBe(false);
  });

  it('keeps the first query when the repair reply is unreadable', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(reply('requests | bad'))
      .mockResolvedValueOnce({ text: 'Sorry, no.' });
    const run = vi.fn(async () => ({ error: 'first error' }));
    const out = await askFlow({ ...base, generate, run });
    expect(out.kql).toBe('requests | bad');
    expect(out.meta.calls).toBe(2);
  });

  it('does not repair after a cancel', async () => {
    const generate = vi.fn(async () => reply('requests'));
    const run = vi.fn(async () => ({ error: 'Cancelled.', cancelled: true }));
    const out = await askFlow({ ...base, generate, run });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(out.result.cancelled).toBe(true);
  });

  it('fails when the first reply has no query', async () => {
    await expect(askFlow({ ...base, generate: async () => ({ text: 'no' }), run: vi.fn() })).rejects.toThrow('did not return a query');
  });
});

describe('CLAUDE_FLAGS', () => {
  it('runs Sonnet lean: no tools, its own short system prompt, no MCP servers or saved session', () => {
    expect(CLAUDE_FLAGS).toContain('--model sonnet');
    expect(CLAUDE_FLAGS).toContain('--tools ""');
    expect(CLAUDE_FLAGS.some(f => f.startsWith('--system-prompt "'))).toBe(true);
    expect(CLAUDE_FLAGS).toEqual(expect.arrayContaining(['--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--permission-prompts none']));
  });

  it('never uses --bare, which would need an API key instead of the CLI login', () => {
    expect(CLAUDE_FLAGS.join(' ')).not.toMatch(/--bare|api-key/i);
  });

  it('keeps the system prompt free of inner quotes, since the command runs through a shell', () => {
    const prompt = CLAUDE_FLAGS.find(f => f.startsWith('--system-prompt'));
    expect(prompt.slice('--system-prompt "'.length, -1)).not.toMatch(/["'`]/);
  });
});
