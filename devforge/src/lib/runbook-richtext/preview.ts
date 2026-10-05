// Read-only HTML for an Activity / Logbook cell in the editor table: the cell's
// own formatting (paragraphs, bold, lists, links, tables, drawers) with the
// Confluence chips made readable — mentions by name, status as a pill, task
// boxes, screenshots and other macros as labelled chips. Built on the editor's
// tokenizer, so raw storage never meets the HTML parser, and sanitized before
// it is rendered.

import { storageToEditorHtml } from '@/lib/runbook-richtext/storage-to-editor';

const COLOUR: Record<string, string> = { grey: 'grey', blue: 'blue', green: 'green', red: 'red', yellow: 'yellow', purple: 'purple' };

function chip(doc: Document, kind: string, text: string, extra: Record<string, string> = {}): HTMLElement {
  const span = doc.createElement('span');
  span.setAttribute('data-preview', kind);
  for (const [k, v] of Object.entries(extra)) span.setAttribute(k, v);
  span.textContent = text;
  return span;
}

// Every cell's preview is rebuilt on each table render; cache per names map
// (a new map arrives when a name is learned, which refreshes the mentions).
const cache = new WeakMap<Map<string, string>, Map<string, string>>();

export function cellPreviewHtml(storage: string, names: Map<string, string>): string {
  let byStorage = cache.get(names);
  if (!byStorage) { byStorage = new Map(); cache.set(names, byStorage); }
  const hit = byStorage.get(storage);
  if (hit !== undefined) return hit;
  const html = buildPreview(storage, names);
  byStorage.set(storage, html);
  return html;
}

function buildPreview(storage: string, names: Map<string, string>): string {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${storageToEditorHtml(storage)}`, 'text/html');
  const root = doc.body;

  // Nothing that can run code or load frames.
  root.querySelectorAll('script, style, link, meta, iframe, object, embed, noscript').forEach(n => n.remove());
  root.querySelectorAll('*').forEach(el => {
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(a.name);
      else if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
    }
  });

  root.querySelectorAll('[data-cf-mention]').forEach(el => {
    const id = el.getAttribute('data-account-id') ?? '';
    el.replaceWith(chip(doc, 'mention', `@${names.get(id) ?? 'Unknown user'}`));
  });
  root.querySelectorAll('[data-cf-status]').forEach(el => {
    const colour = COLOUR[(el.getAttribute('data-colour') ?? '').toLowerCase()] ?? 'grey';
    el.replaceWith(chip(doc, 'status', el.getAttribute('data-title') ?? '', { 'data-status': colour }));
  });
  root.querySelectorAll('[data-cf-raw], [data-cf-raw-block]').forEach(el => {
    el.replaceWith(chip(doc, 'raw', el.getAttribute('data-label') || 'Confluence content'));
  });
  root.querySelectorAll('img[data-cf-image]').forEach(el => {
    el.replaceWith(chip(doc, 'image', `🖼 ${el.getAttribute('data-filename') ?? 'screenshot'}`));
  });
  root.querySelectorAll('li[data-type="taskItem"]').forEach(li => {
    const box = li.getAttribute('data-checked') === 'true' ? '☑ ' : '☐ ';
    const first = li.querySelector('p') ?? li;
    first.insertBefore(doc.createTextNode(box), first.firstChild);
  });
  root.querySelectorAll('a[href]').forEach(a => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return root.innerHTML;
}
