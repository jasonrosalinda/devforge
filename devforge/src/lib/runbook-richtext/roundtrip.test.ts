// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { richTextSchema } from './schema';
import { storageToEditorHtml } from './storage-to-editor';
import { editorJsonToStorage } from './editor-to-storage';

// Storage → editor → storage through a real (headless) Tiptap editor.
function roundTrip(storage: string, start = 500): string {
  const editor = new Editor({ extensions: richTextSchema(), content: storageToEditorHtml(storage) });
  let n = start;
  const out = editorJsonToStorage(editor.getJSON(), { nextTaskId: () => String(++n) });
  editor.destroy();
  return out;
}

describe('rich text round trip', () => {
  it('keeps a logbook drawer with a screenshot and notes', () => {
    const img = '<ac:image ac:align="center" ac:width="760"><ri:attachment ri:filename="ga-1800.png" ri:version-at-save="1" /></ac:image>';
    const x = `<ac:structured-macro ac:name="expand" ac:schema-version="1" ac:macro-id="m"><ac:parameter ac:name="title">6:00 PM</ac:parameter><ac:rich-text-body>${img}<ul><li><p>Active User - 2764 (+3.44%)</p></li></ul></ac:rich-text-body></ac:structured-macro>`;
    expect(roundTrip(x)).toBe(`<ac:structured-macro ac:name="expand" ac:schema-version="1"><ac:parameter ac:name="title">6:00 PM</ac:parameter><ac:rich-text-body>${img}<ul><li><p>Active User - 2764 (+3.44%)</p></li></ul></ac:rich-text-body></ac:structured-macro>`);
  });

  it('keeps mentions, status and dates byte-for-byte inside text', () => {
    const m = '<ac:link><ri:user ri:account-id="a1" ri:local-id="u1" /></ac:link>';
    const s = '<ac:structured-macro ac:name="status" ac:schema-version="1"><ac:parameter ac:name="title">PRDMSPAPP</ac:parameter><ac:parameter ac:name="colour">Red</ac:parameter></ac:structured-macro>';
    expect(roundTrip(`<p>Restore of: ${s} by ${m} on <time datetime="2026-10-26" /></p>`))
      .toBe(`<p>Restore of: ${s} by ${m} on <time datetime="2026-10-26" /></p>`);
  });

  it('keeps a task list with ids and states', () => {
    const t = '<ac:task-list><ac:task><ac:task-id>169</ac:task-id><ac:task-uuid>u-1</ac:task-uuid><ac:task-status>incomplete</ac:task-status><ac:task-body>MSP APP : <strong>TBU</strong></ac:task-body></ac:task></ac:task-list>';
    expect(roundTrip(`<p>Trigger GitHub actions for:</p>${t}`)).toBe(`<p>Trigger GitHub actions for:</p>${t}`);
  });

  it('keeps an unknown macro as a block, untouched', () => {
    const code = '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[a < b]]></ac:plain-text-body></ac:structured-macro>';
    expect(roundTrip(`<p>before</p>${code}<p>after</p>`)).toBe(`<p>before</p>${code}<p>after</p>`);
  });

  it('keeps the key/value table content (layout attributes are dropped)', () => {
    expect(roundTrip('<p>Adding key-value configuration</p><table data-layout="default"><tbody><tr><th><p><strong>Key</strong></p></th><th><p><strong>Value</strong></p></th></tr><tr><td><p>VERIFIED_BADGE_COUNTRIES</p></td><td><p>HK,SG,MY</p></td></tr></tbody></table>'))
      .toBe('<p>Adding key-value configuration</p><table><tbody><tr><th><p><strong>Key</strong></p></th><th><p><strong>Value</strong></p></th></tr><tr><td><p>VERIFIED_BADGE_COUNTRIES</p></td><td><p>HK,SG,MY</p></td></tr></tbody></table>');
  });

  it('survives entities and non-ASCII without double escaping', () => {
    expect(roundTrip('<p>Rollback Confirmation&rarr; A &amp; B &lt;x&gt; “quoted” &minus;5.26%</p>'))
      .toBe('<p>Rollback Confirmation→ A &amp; B &lt;x&gt; “quoted” −5.26%</p>');
  });
});

describe('review fixes', () => {
  const ctx = () => { let n = 500; return { nextTaskId: () => String(++n) }; };

  // C1: a click (selection / focus transaction) or type-then-undo must not change a cell.
  it.each([
    ['ends in a list', '<p>x</p><ul><li><p>a</p></li></ul>'],
    ['ends in a drawer', '<ac:structured-macro ac:name="expand" ac:schema-version="1"><ac:parameter ac:name="title">6:00 PM</ac:parameter><ac:rich-text-body><p>n</p></ac:rich-text-body></ac:structured-macro>'],
    ['ends in a table', '<table><tbody><tr><td><p>k</p></td></tr></tbody></table>'],
  ])('a cell that %s is unchanged after a click and after type + undo', (_label, storage) => {
    const editor = new Editor({ extensions: richTextSchema(), content: storageToEditorHtml(storage) });
    const before = editorJsonToStorage(editor.getJSON(), ctx());
    editor.commands.setTextSelection(1);
    editor.commands.focus();
    expect(editorJsonToStorage(editor.getJSON(), ctx())).toBe(before);
    editor.commands.insertContent('zz');
    editor.commands.undo();
    expect(editorJsonToStorage(editor.getJSON(), ctx())).toBe(before);
    editor.destroy();
  });

  // C2: copy / paste goes through renderHTML → parseHTML; chips must keep everything.
  it('keeps every chip through an HTML (clipboard) round trip', () => {
    const m = '<ac:link><ri:user ri:account-id="a1" /></ac:link>';
    const jira = '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">MSP-1</ac:parameter></ac:structured-macro>';
    const s = '<ac:structured-macro ac:name="status" ac:schema-version="1"><ac:parameter ac:name="title">DONE</ac:parameter><ac:parameter ac:name="colour">Green</ac:parameter></ac:structured-macro>';
    const img = '<ac:image><ri:attachment ri:filename="a.png" /></ac:image>';
    const storage = `<p>t ${jira} ${m} ${s}</p>${img}`;
    const first = new Editor({ extensions: richTextSchema(), content: storageToEditorHtml(storage) });
    const second = new Editor({ extensions: richTextSchema(), content: first.getHTML() });
    expect(editorJsonToStorage(second.getJSON(), ctx())).toBe(storage);
    first.destroy();
    second.destroy();
  });

  it('refuses to write a raw chip that lost its content instead of dropping it', () => {
    expect(() => editorJsonToStorage({ type: 'doc', content: [{ type: 'cfRawBlock', attrs: { xml: '', label: 'jira' } }] }, ctx()))
      .toThrow(/jira/);
  });

  // C3: Enter in a task list makes a new task, which needs a new id.
  it('gives a task created with Enter a new id, not a copy of the one above', () => {
    const t = '<ac:task-list><ac:task><ac:task-id>169</ac:task-id><ac:task-uuid>u-1</ac:task-uuid><ac:task-status>incomplete</ac:task-status><ac:task-body>MSP</ac:task-body></ac:task></ac:task-list>';
    const editor = new Editor({ extensions: richTextSchema(), content: storageToEditorHtml(t) });
    editor.commands.setTextSelection(editor.state.doc.content.size - 3);
    editor.commands.splitListItem('taskItem');
    const out = editorJsonToStorage(editor.getJSON(), ctx());
    expect([...out.matchAll(/<ac:task-id>(\d+)<\/ac:task-id>/g)].map(x => x[1])).toEqual(['169', '501']);
    expect((out.match(/<ac:task-uuid>/g) ?? []).length).toBe(1);
    editor.destroy();
  });
});

describe('editing a status badge', () => {
  it('writes the new text and colour when a loaded lozenge is changed', () => {
    const s = '<ac:structured-macro ac:name="status" ac:schema-version="1" ac:macro-id="m1"><ac:parameter ac:name="title">TODO</ac:parameter><ac:parameter ac:name="mixedCase">true</ac:parameter></ac:structured-macro>';
    const editor = new Editor({ extensions: richTextSchema(), content: storageToEditorHtml(`<p>${s}</p>`) });
    let pos = -1;
    editor.state.doc.descendants((n, p) => { if (n.type.name === 'cfStatus') pos = p; });
    // What the badge's popover does: updateAttributes({ title / colour, xml: '' }).
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { title: 'Deployed', colour: 'Green', xml: '' }));
    let n = 0;
    expect(editorJsonToStorage(editor.getJSON(), { nextTaskId: () => String(++n) })).toBe(
      '<p><ac:structured-macro ac:name="status" ac:schema-version="1"><ac:parameter ac:name="title">Deployed</ac:parameter><ac:parameter ac:name="colour">Green</ac:parameter></ac:structured-macro></p>',
    );
    editor.destroy();
  });
});
