import { describe, it, expect } from 'vitest';
import { editorJsonToStorage, maxTaskId } from './editor-to-storage';

const ctx = (start = 200) => { let n = start; return { nextTaskId: () => String(++n) }; };
const doc = (...content: object[]) => ({ type: 'doc', content });
const p = (...content: object[]) => ({ type: 'paragraph', content });
const t = (text: string, marks?: object[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) });

describe('editorJsonToStorage', () => {
  it('writes paragraphs and marks as storage XHTML, escaping text', () => {
    expect(editorJsonToStorage(doc(
      p(t('A & <b> '), t('bold', [{ type: 'bold' }]), t(' '), t('link', [{ type: 'link', attrs: { href: 'https://x?a=1&b=2', target: '_blank' } }])),
      { type: 'paragraph' },
    ), ctx())).toBe('<p>A &amp; &lt;b&gt; <strong>bold</strong> <a href="https://x?a=1&amp;b=2">link</a></p><p />');
  });

  it('keeps non-ASCII text as characters', () => {
    expect(editorJsonToStorage(doc(p(t('Confirmation→ “After” −5.26%'))), ctx())).toBe('<p>Confirmation→ “After” −5.26%</p>');
  });

  it('writes nested marks innermost last', () => {
    expect(editorJsonToStorage(doc(p(t('x', [{ type: 'bold' }, { type: 'italic' }]))), ctx())).toBe('<p><strong><em>x</em></strong></p>');
  });

  it('writes chips loaded from the page as their original XHTML', () => {
    const m = '<ac:link><ri:user ri:account-id="a1" ri:local-id="u1" /></ac:link>';
    expect(editorJsonToStorage(doc(p(
      { type: 'cfMention', attrs: { accountId: 'a1', xml: m } }, t(' / '),
      { type: 'cfRaw', attrs: { xml: '<time datetime="2026-10-26" />', label: '2026-10-26' } },
    )), ctx())).toBe(`<p>${m} / <time datetime="2026-10-26" /></p>`);
  });

  it('builds chips added in the editor', () => {
    expect(editorJsonToStorage(doc(p(
      { type: 'cfMention', attrs: { accountId: 'a9', xml: '' } },
      { type: 'cfStatus', attrs: { title: 'DONE', colour: 'Green', xml: '' } },
    )), ctx())).toBe('<p><ac:link><ri:user ri:account-id="a9" /></ac:link><ac:structured-macro ac:name="status" ac:schema-version="1"><ac:parameter ac:name="title">DONE</ac:parameter><ac:parameter ac:name="colour">Green</ac:parameter></ac:structured-macro></p>');
  });

  it('writes a drawer as an expand macro with its title and body', () => {
    expect(editorJsonToStorage(doc({
      type: 'details', content: [
        { type: 'detailsSummary', content: [t('6:00 PM')] },
        { type: 'detailsContent', content: [{ type: 'cfImage', attrs: { filename: 'a.png', xml: '' } }, p(t('n'))] },
      ],
    }), ctx())).toBe('<ac:structured-macro ac:name="expand" ac:schema-version="1"><ac:parameter ac:name="title">6:00 PM</ac:parameter><ac:rich-text-body><ac:image><ri:attachment ri:filename="a.png" /></ac:image><p>n</p></ac:rich-text-body></ac:structured-macro>');
  });

  it('writes task items, keeping ids and giving new items the next free id', () => {
    expect(editorJsonToStorage(doc({
      type: 'taskList', content: [
        { type: 'taskItem', attrs: { checked: true, taskId: '169', taskUuid: 'u-1' }, content: [p(t('MSP'))] },
        { type: 'taskItem', attrs: { checked: false, taskId: null, taskUuid: null }, content: [p(t('MEDU'))] },
      ],
    }), ctx(200))).toBe(
      '<ac:task-list><ac:task><ac:task-id>169</ac:task-id><ac:task-uuid>u-1</ac:task-uuid><ac:task-status>complete</ac:task-status><ac:task-body>MSP</ac:task-body></ac:task>' +
      '<ac:task><ac:task-id>201</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>MEDU</ac:task-body></ac:task></ac:task-list>',
    );
  });

  it('writes lists and tables', () => {
    expect(editorJsonToStorage(doc(
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('a'))] }] },
      { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [p(t('b'))] }] },
      { type: 'table', content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 1, rowspan: 1 }, content: [p(t('Key'))] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 2, rowspan: 1 }, content: [{ type: 'paragraph' }] }] },
      ] },
    ), ctx())).toBe('<ul><li><p>a</p></li></ul><ol><li><p>b</p></li></ol><table><tbody><tr><th><p>Key</p></th></tr><tr><td colspan="2"><p /></td></tr></tbody></table>');
  });

  it('writes an empty document as one empty paragraph', () => {
    expect(editorJsonToStorage({ type: 'doc', content: [] }, ctx())).toBe('<p />');
  });
});

describe('maxTaskId', () => {
  it('finds the highest task id on the page', () => {
    expect(maxTaskId('<ac:task-id>7</ac:task-id> <ac:task-id>169</ac:task-id>')).toBe(169);
    expect(maxTaskId('<p />')).toBe(0);
  });
});
