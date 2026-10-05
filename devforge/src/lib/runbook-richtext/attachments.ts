// Screenshot bookkeeping for the rich text editor.

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

const decodeXml = (s: string) => s
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

/** Attachment filenames the storage body shows as images, once each, in order. */
export function referencedImages(storage: string): string[] {
  const out: string[] = [];
  // Self-closing <ri:attachment … /> only: one with a <ri:page> child is another page's file.
  for (const m of storage.matchAll(/<ac:image\b[^>]*>\s*<ri:attachment\b[^>]*ri:filename="([^"]+)"[^>]*\/>/g)) {
    const name = decodeXml(m[1]!);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A new, never-existing attachment name: devforge-<yyyyMMdd-HHmmss>-<seq>.<ext>. */
export function screenshotName(now: Date, seq: number, mediaType: string): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `devforge-${stamp}-${seq}.${EXT[mediaType] ?? 'png'}`;
}

/** null when the edit changed nothing (the cell keeps its original bytes), else the new XHTML. */
export function cellAfterEdit(_original: string, initialSerialized: string, editedSerialized: string): string | null {
  return editedSerialized === initialSerialized ? null : editedSerialized;
}

/** Uploads `names` in order and stops at the first failure, reporting which went up
 *  (so a retry doesn't re-send them: Confluence rejects a duplicate name). */
export async function uploadEach(
  names: string[],
  upload: (name: string) => Promise<string | null>,
): Promise<{ done: string[]; error: string | null }> {
  const done: string[] = [];
  for (const name of names) {
    const err = await upload(name);
    if (err) return { done, error: `${name}: ${err}` };
    done.push(name);
  }
  return { done, error: null };
}

/** Image files to insert for a paste — none when it also carries text: Excel,
 *  Word and OneNote put a picture of the selection next to the real content. */
export function pastedImages(clip: { files: ArrayLike<File>; getData: (type: string) => string }): File[] {
  const images = Array.from(clip.files).filter(f => f.type.startsWith('image/'));
  if (!images.length) return [];
  if (clip.getData('text/plain').trim()) return [];
  const htmlText = clip.getData('text/html').replace(/<img\b[^>]*>/gi, '').replace(/<[^>]*>/g, '').replace(/&nbsp;|\s/g, '');
  return htmlText ? [] : images;
}

/** Formatting in a cell the editor can't keep: applying an edit drops it, so the panel warns first. */
export function unsupportedFormatting(storage: string): string[] {
  const out: string[] = [];
  if (/<(?!col\b)[a-z][^>]*\sstyle="[^"]*(?:(?<![-\w])color|background)/i.test(storage)) out.push('text colour or highlight');
  if (/text-align/i.test(storage)) out.push('text alignment');
  if (/<(?:sup|sub)\b/i.test(storage)) out.push('superscript / subscript');
  if (/<pre\b/i.test(storage)) out.push('preformatted text');
  if (/<table\b[^>]*data-layout|<colgroup\b/i.test(storage)) out.push('table column widths / layout');
  return out;
}
