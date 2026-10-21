import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { leanFlags } = require('./claude-cli.cjs');
const incidentReport = require('./incident-report.cjs');
const unusedAssets = require('./unused-assets.cjs');
const pagespeed = require('./pagespeed-insight.cjs');
const telemetry = require('./telemetry-ask.cjs');

const LEAN = ['--tools ""', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--permission-prompts none'];

describe('leanFlags', () => {
  it('drops tools, customizations and MCP, and sets the system prompt', () => {
    expect(leanFlags('You check things.')).toEqual([
      '--tools ""',
      '--system-prompt "You check things."',
      '--safe-mode',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--permission-prompts none',
    ]);
  });

  it.each(['', 'say "hi"', "it's", 'a `b`', 'two\nlines'])('refuses a system prompt the shell would break: %j', (prompt) => {
    expect(() => leanFlags(prompt)).toThrow('quote-free');
  });
});

// Every no-tool Claude call in the app runs lean, and none can fall back to API billing.
describe('no-tool Claude commands', () => {
  const commands = {
    'RCA (opus)': incidentReport._rcaCommand({ model: 'opus' }),
    'RCA (sonnet fallback)': incidentReport._rcaCommand({ model: 'sonnet' }),
    'AI remarks': incidentReport._rcaCommand({ systemPrompt: incidentReport._AI_REMARKS_SYSTEM_PROMPT }),
    'Unused Assets review': unusedAssets._reviewCommand(),
    'PageSpeed analysis': `claude -p "x" ${pagespeed._ANALYSIS_FLAGS.join(' ')}`,
    'Ask Telemetry': `claude -p "x" ${telemetry.CLAUDE_FLAGS.join(' ')}`,
  };

  it.each(Object.entries(commands))('%s runs lean', (_name, command) => {
    for (const flag of LEAN) expect(command).toContain(flag);
    expect(command).toMatch(/--system-prompt "[^"']+"/);
  });

  it.each(Object.entries(commands))('%s never uses --bare or an API key', (_name, command) => {
    expect(command).not.toMatch(/--bare|api-key|ANTHROPIC/i);
  });

  it('keeps the model each feature asked for', () => {
    expect(commands['RCA (opus)']).toContain('--model opus');
    expect(commands['AI remarks']).toContain('--model sonnet');
    expect(commands['AI remarks']).toContain('health analyst');
    expect(commands['Unused Assets review']).toContain('--model sonnet');
  });
});
