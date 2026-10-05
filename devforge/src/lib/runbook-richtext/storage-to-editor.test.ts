// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { storageToEditorHtml } from './storage-to-editor';

const enc = encodeURIComponent;

describe('storageToEditorHtml', () => {
  it('passes plain HTML through and opens self-closing paragraphs', () => {
    expect(storageToEditorHtml('<p>A <strong>b</strong> <a href="https://x">l</a></p><p local-id="e" />'))
      .toBe('<p>A <strong>b</strong> <a href="https://x">l</a></p><p local-id="e"></p>');
  });

  it('turns a mention into a chip carrying the original XHTML', () => {
    const m = '<ac:link><ri:user ri:account-id="a1" ri:local-id="u1" /></ac:link>';
    expect(storageToEditorHtml(`<p>${m} / x</p>`))
      .toBe(`<p><span data-cf-mention="" data-account-id="a1" data-xml="${enc(m)}"></span> / x</p>`);
  });

  it('turns a status lozenge into a chip with title and colour', () => {
    const s = '<ac:structured-macro ac:name="status" ac:schema-version="1"><ac:parameter ac:name="title">PRDMSPAPP</ac:parameter><ac:parameter ac:name="colour">Red</ac:parameter></ac:structured-macro>';
    expect(storageToEditorHtml(`<p>of: ${s}</p>`))
      .toBe(`<p>of: <span data-cf-status="" data-title="PRDMSPAPP" data-colour="Red" data-xml="${enc(s)}"></span></p>`);
  });

  it('turns an expand macro into a drawer and converts its body, including a screenshot', () => {
    const img = '<ac:image ac:align="center" ac:width="760"><ri:attachment ri:filename="ga-1800.png" ri:version-at-save="1" /></ac:image>';
    const x = `<ac:structured-macro ac:name="expand" ac:schema-version="1" ac:macro-id="m"><ac:parameter ac:name="title">6:00 PM</ac:parameter><ac:rich-text-body>${img}<ul><li><p>Active User</p></li></ul></ac:rich-text-body></ac:structured-macro>`;
    expect(storageToEditorHtml(x)).toBe(
      `<details><summary>6:00 PM</summary><div data-type="detailsContent"><img data-cf-image="" data-filename="ga-1800.png" data-xml="${enc(img)}"><ul><li><p>Active User</p></li></ul></div></details>`,
    );
  });

  it('reads only the drawer\'s own title, not a nested macro\'s', () => {
    const inner = '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">inner</ac:parameter><ac:rich-text-body><p>i</p></ac:rich-text-body></ac:structured-macro>';
    const outer = `<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">outer</ac:parameter><ac:rich-text-body>${inner}</ac:rich-text-body></ac:structured-macro>`;
    expect(storageToEditorHtml(outer)).toBe(
      '<details><summary>outer</summary><div data-type="detailsContent"><details><summary>inner</summary><div data-type="detailsContent"><p>i</p></div></details></div></details>',
    );
  });

  it('turns a task list into task items keeping id, uuid and state', () => {
    const t = '<ac:task-list><ac:task><ac:task-id>169</ac:task-id><ac:task-uuid>u-1</ac:task-uuid><ac:task-status>incomplete</ac:task-status><ac:task-body>MSP APP : <strong>TBU</strong></ac:task-body></ac:task>' +
      '<ac:task><ac:task-id>170</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body><span>MEDU</span></ac:task-body></ac:task></ac:task-list>';
    expect(storageToEditorHtml(t)).toBe(
      '<ul data-type="taskList">' +
      '<li data-type="taskItem" data-checked="false" data-task-id="169" data-task-uuid="u-1"><p>MSP APP : <strong>TBU</strong></p></li>' +
      '<li data-type="taskItem" data-checked="true" data-task-id="170" data-task-uuid=""><p><span>MEDU</span></p></li></ul>',
    );
  });

  it('keeps any other macro, dates and emoticons as raw chips, inline or block by context', () => {
    const code = '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[a < b]]></ac:plain-text-body></ac:structured-macro>';
    const time = '<time datetime="2026-10-26" />';
    expect(storageToEditorHtml(`${code}<p>on ${time}</p>`)).toBe(
      `<div data-cf-raw-block="" data-label="code" data-xml="${enc(code)}"></div>` +
      `<p>on <span data-cf-raw="" data-label="2026-10-26" data-xml="${enc(time)}"></span></p>`,
    );
  });

  it('keeps a nested key/value table as an editable table', () => {
    const t = '<table data-layout="default"><colgroup><col style="width: 80px;" /></colgroup><tbody><tr><th><p>Key</p></th></tr><tr><td><p>HK,SG,MY</p></td></tr></tbody></table>';
    expect(storageToEditorHtml(t)).toBe(
      '<table data-layout="default"><colgroup><col style="width: 80px;" /></colgroup><tbody><tr><th><p>Key</p></th></tr><tr><td><p>HK,SG,MY</p></td></tr></tbody></table>',
    );
  });
});

describe('review fixes', () => {
  // I4: <p><ac:image/></p> must not turn into an empty paragraph plus an image.
  it('unwraps a paragraph that holds only a screenshot', () => {
    const img = '<ac:image ac:width="760"><ri:attachment ri:filename="a.png" /></ac:image>';
    expect(storageToEditorHtml(`<p local-id="x">${img}</p>`))
      .toBe(`<img data-cf-image="" data-filename="a.png" data-xml="${encodeURIComponent(img)}">`);
  });
});
