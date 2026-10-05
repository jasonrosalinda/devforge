// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { cellPreviewHtml } from './preview';

const names = new Map([['a1', 'Jason Rosalinda']]);
const el = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d; };

describe('cellPreviewHtml', () => {
  it('keeps the cell\'s formatting: text, link, table', () => {
    const out = el(cellPreviewHtml(
      '<p>MSP App Configuration - <a href="https://portal.azure.com/x">prdmsp-config</a></p><p>Adding key-value configuration</p>' +
      '<table data-layout="default"><tbody><tr><th><p><strong>Key</strong></p></th></tr><tr><td><p>HK,SG,MY,PH</p></td></tr></tbody></table>', names));
    expect(out.querySelector('a')!.getAttribute('href')).toBe('https://portal.azure.com/x');
    expect(out.querySelector('a')!.getAttribute('target')).toBe('_blank');
    expect(out.querySelector('th strong')!.textContent).toBe('Key');
    expect(out.querySelector('td')!.textContent).toBe('HK,SG,MY,PH');
  });

  it('shows mentions by name, status as a pill and tasks with their box', () => {
    const out = el(cellPreviewHtml(
      '<p><ac:link><ri:user ri:account-id="a1" /></ac:link> <ac:structured-macro ac:name="status"><ac:parameter ac:name="title">PRDMSPAPP</ac:parameter><ac:parameter ac:name="colour">Red</ac:parameter></ac:structured-macro></p>' +
      '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>MSP APP</ac:task-body></ac:task></ac:task-list>', names));
    expect(out.querySelector('[data-preview=mention]')!.textContent).toBe('@Jason Rosalinda');
    const pill = out.querySelector('[data-preview=status]')!;
    expect(pill.textContent).toBe('PRDMSPAPP');
    expect(pill.getAttribute('data-status')).toBe('red');
    expect(out.querySelector('li')!.textContent).toBe('☑ MSP APP');
  });

  it('shows screenshots and other Confluence content as labelled chips, drawers as drawers', () => {
    const out = el(cellPreviewHtml(
      '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">6:00 PM</ac:parameter><ac:rich-text-body><ac:image><ri:attachment ri:filename="ga.png" /></ac:image></ac:rich-text-body></ac:structured-macro>' +
      '<p>on <time datetime="2026-10-26" /></p>', names));
    expect(out.querySelector('details summary')!.textContent).toBe('6:00 PM');
    expect(out.querySelector('[data-preview=image]')!.textContent).toBe('🖼 ga.png');
    expect(out.querySelector('[data-preview=raw]')!.textContent).toBe('2026-10-26');
  });

  it('strips anything that could run code', () => {
    const out = el(cellPreviewHtml('<p onclick="x()">a</p><script>x()</script><a href="javascript:x()">b</a><iframe></iframe>', names));
    expect(out.querySelector('script, iframe')).toBeNull();
    expect(out.querySelector('p')!.hasAttribute('onclick')).toBe(false);
    expect(out.querySelector('a')!.hasAttribute('href')).toBe(false);
  });
});
