import { describe, it, expect } from 'vitest';
import { referencedImages, screenshotName, cellAfterEdit, uploadEach, pastedImages, unsupportedFormatting } from './attachments';

describe('referencedImages', () => {
  it('lists each attached image once, in order, decoding entities', () => {
    expect(referencedImages(
      '<ac:image><ri:attachment ri:filename="b.png" /></ac:image><ac:image><ri:attachment ri:filename="a&amp;b.png" ri:version-at-save="1" /></ac:image><ac:image><ri:attachment ri:filename="b.png" /></ac:image><ac:image><ri:url ri:value="https://x/y.png" /></ac:image>',
    )).toEqual(['b.png', 'a&b.png']);
  });

  it('drops a pasted image that was deleted again (only names still in the page count)', () => {
    const pending = ['devforge-20261109-180000-1.png', 'devforge-20261109-180000-2.png'];
    const saved = '<ac:image><ri:attachment ri:filename="devforge-20261109-180000-2.png" /></ac:image>';
    expect(pending.filter(f => referencedImages(saved).includes(f))).toEqual(['devforge-20261109-180000-2.png']);
  });
});

describe('screenshotName', () => {
  it('stamps the local time and a sequence number, so pastes in the same second differ', () => {
    const at = new Date(2026, 10, 9, 18, 0, 5);
    expect(screenshotName(at, 1, 'image/png')).toBe('devforge-20261109-180005-1.png');
    expect(screenshotName(at, 2, 'image/jpeg')).toBe('devforge-20261109-180005-2.jpg');
    expect(screenshotName(at, 3, 'image/webp')).toBe('devforge-20261109-180005-3.webp');
  });
});

describe('cellAfterEdit', () => {
  it('keeps the original bytes when the content ends up the same (edit then undo)', () => {
    expect(cellAfterEdit('<p local-id="x">Hi</p>', '<p>Hi</p>', '<p>Hi</p>')).toBeNull();
  });

  it('returns the new XHTML when the content changed', () => {
    expect(cellAfterEdit('<p local-id="x">Hi</p>', '<p>Hi</p>', '<p>Hi there</p>')).toBe('<p>Hi there</p>');
  });
});

describe('review fixes', () => {
  // I1: an image of another page's attachment is not this page's file to copy.
  it('leaves out images that point at another page\'s attachment', () => {
    expect(referencedImages(
      '<ac:image><ri:attachment ri:filename="own.png" /></ac:image>' +
      '<ac:image><ri:attachment ri:filename="other.png"><ri:page ri:content-title="Elsewhere" /></ri:attachment></ac:image>',
    )).toEqual(['own.png']);
  });

  // I2: a retry must not re-send files that already went up.
  it('uploads in order, stops at the first failure and reports what went up', async () => {
    const sent: string[] = [];
    const res = await uploadEach(['a.png', 'b.png', 'c.png'], async name => {
      sent.push(name);
      return name === 'b.png' ? 'rejected' : null;
    });
    expect(sent).toEqual(['a.png', 'b.png']);
    expect(res).toEqual({ done: ['a.png'], error: 'b.png: rejected' });
  });

  // I5: Office pastes put a picture of the selection next to the real text.
  it('treats a paste as screenshots only when it carries no text', () => {
    const png = new File([new Uint8Array([1])], 'image.png', { type: 'image/png' });
    const clip = (text: Record<string, string>, files: File[]) => ({ files, getData: (t: string) => text[t] ?? '' });
    expect(pastedImages(clip({}, [png]))).toEqual([png]);
    expect(pastedImages(clip({ 'text/html': '<table><tr><td>A1</td></tr></table>' }, [png]))).toEqual([]);
    expect(pastedImages(clip({ 'text/plain': 'A1\tB1' }, [png]))).toEqual([]);
    expect(pastedImages(clip({ 'text/html': '<img src="x">' }, [png]))).toEqual([png]);
  });

  // I4: say what an edit would drop, before the user applies it.
  it('names the formatting the editor cannot keep', () => {
    expect(unsupportedFormatting('<p>plain <strong>bold</strong></p><ul><li><p>x</p></li></ul>')).toEqual([]);
    expect(unsupportedFormatting(
      '<p style="text-align: center;">c</p><p><span style="color: rgb(255,0,0);">red</span> x<sup>2</sup></p><pre>code</pre><table data-layout="wide"><colgroup><col style="width: 80px;" /></colgroup><tbody /></table>',
    )).toEqual(['text colour or highlight', 'text alignment', 'superscript / subscript', 'preformatted text', 'table column widths / layout']);
  });
});
