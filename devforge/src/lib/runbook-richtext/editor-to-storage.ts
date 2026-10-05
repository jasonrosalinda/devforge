// Tiptap JSON (schema in ./schema.ts) → Confluence storage XHTML for one cell.
// Chips loaded from the page carry their original XHTML (`xml`) and are written
// back unchanged; chips created in the editor are built here.

import type { JSONContent } from '@tiptap/core';

export interface SerializeContext {
  nextTaskId: () => string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const MARK_TAG: Record<string, string> = { bold: 'strong', italic: 'em', code: 'code', strike: 's', underline: 'u' };

function text(node: JSONContent): string {
  let out = esc(node.text ?? '');
  for (const mark of [...(node.marks ?? [])].reverse()) {
    if (mark.type === 'link') out = `<a href="${esc(String(mark.attrs?.href ?? ''))}">${out}</a>`;
    else if (MARK_TAG[mark.type]) out = `<${MARK_TAG[mark.type]}>${out}</${MARK_TAG[mark.type]}>`;
  }
  return out;
}

function inline(nodes: JSONContent[] | undefined, ctx: SerializeContext): string {
  return (nodes ?? []).map(n => {
    switch (n.type) {
      case 'text': return text(n);
      case 'hardBreak': return '<br />';
      case 'cfMention': return n.attrs?.xml || `<ac:link><ri:user ri:account-id="${esc(String(n.attrs?.accountId ?? ''))}" /></ac:link>`;
      case 'cfStatus': return n.attrs?.xml || statusMacro(String(n.attrs?.title ?? ''), String(n.attrs?.colour ?? 'Grey'));
      case 'cfRaw': return rawXml(n);
      default: return block(n, ctx);
    }
  }).join('');
}

// A raw chip is Confluence content the editor can't edit; writing it empty would
// delete that content, so refuse instead.
function rawXml(n: JSONContent): string {
  const xml = String(n.attrs?.xml ?? '');
  if (!xml) throw new Error(`Confluence content (${String(n.attrs?.label || 'macro')}) was lost in the editor; not saving it.`);
  return xml;
}

function statusMacro(title: string, colour: string): string {
  return `<ac:structured-macro ac:name="status" ac:schema-version="1"><ac:parameter ac:name="title">${esc(title)}</ac:parameter><ac:parameter ac:name="colour">${esc(colour)}</ac:parameter></ac:structured-macro>`;
}

const blocks = (nodes: JSONContent[] | undefined, ctx: SerializeContext) => (nodes ?? []).map(n => block(n, ctx)).join('');

function cell(tag: 'th' | 'td', n: JSONContent, ctx: SerializeContext): string {
  const span = (k: 'colspan' | 'rowspan') => (Number(n.attrs?.[k] ?? 1) > 1 ? ` ${k}="${n.attrs![k]}"` : '');
  return `<${tag}${span('colspan')}${span('rowspan')}>${blocks(n.content, ctx) || '<p />'}</${tag}>`;
}

function block(n: JSONContent, ctx: SerializeContext): string {
  switch (n.type) {
    case 'paragraph': { const i = inline(n.content, ctx); return i ? `<p>${i}</p>` : '<p />'; }
    case 'heading': { const l = Number(n.attrs?.level ?? 2); return `<h${l}>${inline(n.content, ctx)}</h${l}>`; }
    case 'bulletList': return `<ul>${blocks(n.content, ctx)}</ul>`;
    case 'orderedList': { const s = Number(n.attrs?.start ?? 1); return `<ol${s !== 1 ? ` start="${s}"` : ''}>${blocks(n.content, ctx)}</ol>`; }
    case 'listItem': return `<li>${blocks(n.content, ctx)}</li>`;
    case 'blockquote': return `<blockquote>${blocks(n.content, ctx)}</blockquote>`;
    case 'horizontalRule': return '<hr />';
    case 'table': return `<table><tbody>${blocks(n.content, ctx)}</tbody></table>`;
    case 'tableRow': return `<tr>${blocks(n.content, ctx)}</tr>`;
    case 'tableHeader': return cell('th', n, ctx);
    case 'tableCell': return cell('td', n, ctx);
    case 'taskList': return `<ac:task-list>${blocks(n.content, ctx)}</ac:task-list>`;
    case 'taskItem': {
      const [first, ...rest] = n.content ?? [];
      const id = n.attrs?.taskId ? String(n.attrs.taskId) : ctx.nextTaskId();
      const uuid = n.attrs?.taskUuid ? `<ac:task-uuid>${esc(String(n.attrs.taskUuid))}</ac:task-uuid>` : '';
      const status = n.attrs?.checked ? 'complete' : 'incomplete';
      const body = (first?.type === 'paragraph' ? inline(first.content, ctx) : block(first ?? {}, ctx)) + blocks(rest, ctx);
      return `<ac:task><ac:task-id>${id}</ac:task-id>${uuid}<ac:task-status>${status}</ac:task-status><ac:task-body>${body}</ac:task-body></ac:task>`;
    }
    case 'details': {
      const summary = n.content?.find(c => c.type === 'detailsSummary');
      const body = n.content?.find(c => c.type === 'detailsContent');
      const title = (summary?.content ?? []).map(c => c.text ?? '').join('');
      return `<ac:structured-macro ac:name="expand" ac:schema-version="1"><ac:parameter ac:name="title">${esc(title)}</ac:parameter><ac:rich-text-body>${blocks(body?.content, ctx) || '<p />'}</ac:rich-text-body></ac:structured-macro>`;
    }
    case 'cfImage': return n.attrs?.xml || `<ac:image><ri:attachment ri:filename="${esc(String(n.attrs?.filename ?? ''))}" /></ac:image>`;
    case 'cfRawBlock': return rawXml(n);
    case 'cfRaw': case 'cfMention': case 'cfStatus': case 'text': case 'hardBreak': return `<p>${inline([n], ctx)}</p>`;
    default: return blocks(n.content, ctx);
  }
}

export function editorJsonToStorage(doc: JSONContent, ctx: SerializeContext): string {
  return blocks(doc.content, ctx) || '<p />';
}

/** Highest <ac:task-id> on the page; new task items continue from it. */
export function maxTaskId(storage: string): number {
  return [...storage.matchAll(/<ac:task-id>(\d+)<\/ac:task-id>/g)].reduce((m, x) => Math.max(m, Number(x[1])), 0);
}
