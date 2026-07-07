'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Reads .git/HEAD directly off disk — browsers' webkitdirectory picker hides
// dotfiles/dotfolders from the renderer's FileList, so this is Electron-only.
// Walks up parent directories (like git itself) since the scanned folder is
// often a subfolder of the repo root, not the root itself.
function findGitHead(startDir) {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    const headPath = path.join(dir, '.git', 'HEAD');
    if (fs.existsSync(headPath)) return headPath;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function readGitBranch(folderPath) {
  const headPath = findGitHead(folderPath);
  if (!headPath) return null;
  const content = fs.readFileSync(headPath, 'utf8').trim();
  const match = /^ref:\s*refs\/heads\/(.+)$/.exec(content);
  if (match) return match[1];
  return `${content.slice(0, 7)} (detached)`;
}

// Tracks the in-flight Claude CLI child process so a cancel request from the
// renderer can kill it. Single-flight: the UI only allows one review at a time.
let currentChild = null;
let cancelled = false;

// Spawns the Claude CLI in headless print mode, feeds the review prompt via
// stdin, and resolves with the raw stdout. Uses the user's existing Claude
// Code auth — same mechanism as the incident-report RCA feature.
function runClaudeReview({ promptBody, onStage, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    const directive = 'Verify the unused-asset candidates on standard input using the occurrence evidence provided. Respond with ONLY the JSON array specified — no prose, no markdown fences.';

    let child;
    try {
      child = spawn(`claude -p "${directive}" --output-format text --model sonnet`, {
        shell: true,
        cwd: os.tmpdir(),
        env: process.env,
        windowsHide: true,
      });
    } catch (err) {
      reject(new Error(`Failed to launch Claude CLI: ${err.message}`));
      return;
    }
    currentChild = child;

    let out = '';
    let errOut = '';
    let settled = false;
    const finish = (fn, arg) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (currentChild === child) currentChild = null;
        fn(arg);
      }
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(reject, new Error('Claude review timed out.'));
    }, timeoutMs);

    onStage && onStage('Running Claude review (Sonnet)');

    child.on('error', (err) => {
      const msg = /ENOENT|not recognized|not found/i.test(err.message)
        ? 'Claude CLI not found on PATH — install Claude Code or check your PATH.'
        : `Claude CLI error: ${err.message}`;
      finish(reject, new Error(msg));
    });
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    child.on('close', (code) => {
      if (cancelled) return finish(reject, new Error('CANCELLED'));
      if (code === 0 && out.trim()) return finish(resolve, out.trim());
      if (/not recognized|ENOENT|not found/i.test(errOut)) {
        return finish(reject, new Error('Claude CLI not found on PATH — install Claude Code or check your PATH.'));
      }
      const tail = (errOut || out).trim().slice(-400);
      finish(reject, new Error(`Claude review failed (exit ${code}).${tail ? ' ' + tail : ''}`));
    });

    try {
      child.stdin.write(promptBody);
      child.stdin.end();
    } catch (err) {
      finish(reject, new Error(`Failed to send review payload to Claude: ${err.message}`));
    }
  });
}

function buildReviewPrompt(candidates, evidence) {
  const sections = candidates.map((c) => {
    const hits = evidence[c.id] || [];
    const hitLines = hits.length
      ? hits.map((h) => `  ${h.file}:${h.line}: ${h.text}`).join('\n')
      : '  (no other occurrences found in the scanned project)';
    return `### ${c.id}\nkind: ${c.kind}\nname: ${c.name}\ndefined at: ${c.file}:${c.line}\noccurrences elsewhere:\n${hitLines}`;
  }).join('\n\n');

  return `You are a conservative static-analysis verifier for unused CSS classes/ids and unused JS/TS functions. A regex-based scanner flagged the candidates below as having no detected usage; for each one, decide whether it is safe to delete, using ONLY the occurrence evidence provided (already grepped from the project — do not assume access to any other files).

Mark "confirmed-unused" only when there is no plausible usage at all. Mark "false-positive" if the evidence shows real usage (including dynamic construction via string concatenation/interpolation, clsx/classnames/template literals, JSInterop/InvokeAsync, data-* attribute selectors, or reflection). Mark "needs-review" when the evidence is ambiguous.

Respond with ONLY a JSON array, no prose, no markdown code fences, in this exact shape:
[{"id": "<candidate id>", "verdict": "confirmed-unused" | "false-positive" | "needs-review", "reason": "<one short sentence>"}]

## CANDIDATES

${sections}`;
}

const handler = (_mainWindow) => {
  const { ipcMain } = require('electron');

  ipcMain.handle('unused-assets:git-branch', async (_event, opts) => {
    try {
      const { folderPath } = opts || {};
      if (!folderPath) return { success: false, error: 'No folder path provided.' };
      const branch = readGitBranch(folderPath);
      return { success: true, branch };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('unused-assets:review', async (event, opts) => {
    const emit = (stage) => {
      if (!event.sender.isDestroyed()) event.sender.send('unused-assets:review-progress', { stage });
    };
    cancelled = false;
    try {
      const { candidates, evidence } = opts;
      if (!Array.isArray(candidates) || candidates.length === 0) {
        return { success: false, error: 'No candidates to review.' };
      }

      emit(`Gathering evidence for ${candidates.length} candidate(s)`);
      const promptBody = buildReviewPrompt(candidates, evidence || {});

      const raw = await runClaudeReview({ promptBody, onStage: emit });

      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      let verdicts;
      try {
        verdicts = JSON.parse(cleaned);
      } catch {
        return { success: false, error: 'Claude returned a non-JSON response.' };
      }
      if (!Array.isArray(verdicts)) {
        return { success: false, error: 'Claude response was not a JSON array.' };
      }

      return { success: true, verdicts };
    } catch (err) {
      if (err.message === 'CANCELLED') return { success: false, cancelled: true, error: 'Cancelled.' };
      return { success: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('unused-assets:review-cancel', () => {
    if (!currentChild) return { success: false, error: 'No active review.' };
    cancelled = true;
    try {
      currentChild.kill();
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
    return { success: true };
  });
};

module.exports = handler;
