import { describe, it, expect } from 'vitest';
import { imageFilesFrom } from './richTextField';

const file = (type: string) => new File(['x'], 'f', { type });
const item = (f: File, kind = 'file') => ({ kind, type: f.type, getAsFile: () => f }) as unknown as DataTransferItem;

describe('imageFilesFrom', () => {
  it('takes images from clipboard items, as a copied screenshot arrives', () => {
    const png = file('image/png');
    expect(imageFilesFrom({ items: [item(png), item(file('text/plain'))], files: [] })).toEqual([png]);
  });

  it('falls back to files when the items carry none', () => {
    const jpg = file('image/jpeg');
    expect(imageFilesFrom({ items: [], files: [jpg, file('application/pdf')] })).toEqual([jpg]);
  });

  it('ignores text pastes', () => {
    const text = { kind: 'string', type: 'text/plain', getAsFile: () => null } as unknown as DataTransferItem;
    expect(imageFilesFrom({ items: [text], files: [] })).toEqual([]);
    expect(imageFilesFrom({})).toEqual([]);
  });
});
