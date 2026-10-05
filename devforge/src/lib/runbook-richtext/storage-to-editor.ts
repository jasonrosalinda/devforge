// Confluence storage XHTML (one cell) → HTML the Tiptap schema in ./schema.ts parses.
//
// Raw storage never meets an HTML parser: self-closing <ri:… /> / <time /> /
// <p /> tags would swallow their siblings. This tokenizer rewrites every
// namespaced element (and <time>) into a chip that carries its original
// XHTML, turns drawers and task lists into editor structures, and re-opens
// self-closing non-void tags. Everything else passes through as written.

const VOID = new Set(['br', 'hr', 'img', 'col', 'input', 'meta', 'link', 'wbr', 'area', 'base', 'source', 'track', 'embed', 'param']);
const INLINE = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'code', 'sup', 'sub', 'del', 'ins']);
const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g;

const enc = encodeURIComponent;
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Offset just past the element that starts at `start` (balanced by tag name). */
function elementEnd(xml: string, start: number, name: string): number {
  const re = new RegExp(`<(/?)${escRe(name)}(?=[\\s/>])[^>]*?(/?)>`, 'g');
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[1]) { depth--; if (depth === 0) return m.index + m[0].length; continue; }
    if (m[2]) { if (depth === 0) return m.index + m[0].length; continue; }
    depth++;
  }
  return xml.length;
}

/** Inner XHTML of the first `<name>…</name>` child, balanced. */
function childBody(xml: string, name: string): string | null {
  const open = xml.search(new RegExp(`<${escRe(name)}(?=[\\s>])`));
  if (open < 0) return null;
  const end = elementEnd(xml, open, name);
  const head = xml.indexOf('>', open) + 1;
  return xml.slice(head, end - `</${name}>`.length);
}

/** A macro's own parameter (ignores parameters of macros nested in its body). */
function ownParam(macro: string, name: string): string | null {
  const bodyAt = macro.search(/<ac:(?:rich|plain)-text-body/);
  const head = bodyAt < 0 ? macro : macro.slice(0, bodyAt);
  return head.match(new RegExp(`<ac:parameter ac:name="${escRe(name)}">([\\s\\S]*?)</ac:parameter>`))?.[1] ?? null;
}

const attr = (s: string) => s.replace(/"/g, '&quot;');

function rawChip(xml: string, label: string, inline: boolean): string {
  return inline
    ? `<span data-cf-raw="" data-label="${attr(label)}" data-xml="${enc(xml)}"></span>`
    : `<div data-cf-raw-block="" data-label="${attr(label)}" data-xml="${enc(xml)}"></div>`;
}

const BLOCK_START = /<(?:p|ul|ol|table|details|div|h[1-6]|blockquote)\b/;

function taskList(xml: string): string {
  let out = '<ul data-type="taskList">';
  let cursor = 0;
  for (;;) {
    const at = xml.indexOf('<ac:task>', cursor);
    if (at < 0) break;
    const end = elementEnd(xml, at, 'ac:task');
    const task = xml.slice(at, end);
    const id = task.match(/<ac:task-id>(\d+)<\/ac:task-id>/)?.[1] ?? '';
    const uuid = task.match(/<ac:task-uuid>([^<]*)<\/ac:task-uuid>/)?.[1] ?? '';
    const done = /<ac:task-status>\s*complete\s*<\/ac:task-status>/.test(task.slice(0, task.indexOf('<ac:task-body')));
    const body = convert(childBody(task, 'ac:task-body') ?? '');
    const split = body.search(BLOCK_START);
    const lead = split < 0 ? body : body.slice(0, split);
    const rest = split < 0 ? '' : body.slice(split);
    out += `<li data-type="taskItem" data-checked="${done}" data-task-id="${id}" data-task-uuid="${attr(uuid)}"><p>${lead}</p>${rest}</li>`;
    cursor = end;
  }
  return `${out}</ul>`;
}

function namespaced(el: string, name: string, inline: boolean): string {
  if (name === 'ac:structured-macro') {
    const macro = el.match(/ac:name="([^"]+)"/)?.[1] ?? 'macro';
    if (macro === 'expand') {
      const title = ownParam(el, 'title') ?? '';
      return `<details><summary>${title}</summary><div data-type="detailsContent">${convert(childBody(el, 'ac:rich-text-body') ?? '')}</div></details>`;
    }
    if (macro === 'status') {
      return `<span data-cf-status="" data-title="${attr(ownParam(el, 'title') ?? '')}" data-colour="${attr(ownParam(el, 'colour') ?? '')}" data-xml="${enc(el)}"></span>`;
    }
    return rawChip(el, macro, inline);
  }
  if (name === 'ac:link') {
    const id = el.match(/<ri:user\b[^>]*ri:account-id="([^"]+)"/)?.[1];
    if (id) return `<span data-cf-mention="" data-account-id="${attr(id)}" data-xml="${enc(el)}"></span>`;
    return rawChip(el, 'link', true);
  }
  if (name === 'ac:image') {
    const file = el.match(/<ri:attachment\b[^>]*ri:filename="([^"]+)"/)?.[1];
    if (file) return `<img data-cf-image="" data-filename="${attr(file)}" data-xml="${enc(el)}">`;
    return rawChip(el, 'image', inline);
  }
  if (name === 'ac:task-list') return taskList(el);
  if (name === 'time') return rawChip(el, el.match(/datetime="([^"]+)"/)?.[1] ?? 'date', inline);
  return rawChip(el, name.replace(/^(ac|ri):/, ''), inline);
}

// <p><ac:image/></p>: the editor's image is a block, so the paragraph would
// survive as an extra empty line. Unwrap a paragraph holding only one image.
const IMAGE_ONLY_P = /<p\b[^>]*>\s*(<ac:image\b(?:(?!<\/ac:image>)[\s\S])*<\/ac:image>)\s*<\/p>/g;

export function storageToEditorHtml(xml: string): string {
  return convert(xml.replace(IMAGE_ONLY_P, '$1'));
}

function convert(xml: string): string {
  let out = '';
  let cursor = 0;
  const stack: string[] = [];
  TAG_RE.lastIndex = 0;
  const re = new RegExp(TAG_RE.source, 'g');
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const [whole, slash, rawName, attrs, selfClose] = m;
    const name = rawName!.toLowerCase();
    out += xml.slice(cursor, m.index);
    cursor = m.index + whole.length;

    if (!slash && (name.includes(':') || name === 'time')) {
      const end = selfClose ? cursor : elementEnd(xml, m.index, rawName!);
      const inline = INLINE.has(stack[stack.length - 1] ?? '');
      out += namespaced(xml.slice(m.index, end), name, inline);
      cursor = end;
      re.lastIndex = end;
      continue;
    }
    if (slash) {
      const i = stack.lastIndexOf(name);
      if (i >= 0) stack.length = i;
      out += whole;
      continue;
    }
    if (selfClose && !VOID.has(name)) { out += `<${rawName}${attrs!.trimEnd()}></${rawName}>`; continue; }
    if (!VOID.has(name)) stack.push(name);
    out += whole;
  }
  return out + xml.slice(cursor);
}
