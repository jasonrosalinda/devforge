import { describe, it, expect } from 'vitest';
import {
    buildEmbedSvg,
    encodeIco,
    fitSize,
    formatBytes,
    outputFileName,
    sizeChange,
    traceSize,
    traceToSvg,
} from './imageConvert';

describe('fitSize', () => {
    const src = { width: 800, height: 600 };

    it('keeps the source size when nothing is typed', () => {
        expect(fitSize(src, { lockAspect: true })).toEqual({ width: 800, height: 600 });
    });

    it('derives the other side from the one typed when the aspect is locked', () => {
        expect(fitSize(src, { width: 400, lockAspect: true })).toEqual({ width: 400, height: 300 });
        expect(fitSize(src, { height: 150, lockAspect: true })).toEqual({ width: 200, height: 150 });
    });

    it('lets width win when both are typed and the aspect is locked', () => {
        expect(fitSize(src, { width: 400, height: 999, lockAspect: true })).toEqual({ width: 400, height: 300 });
    });

    it('uses both sides as typed when unlocked, filling a blank side from the source', () => {
        expect(fitSize(src, { width: 100, height: 100, lockAspect: false })).toEqual({ width: 100, height: 100 });
        expect(fitSize(src, { width: 100, lockAspect: false })).toEqual({ width: 100, height: 600 });
    });

    it('never goes below 1px or above the canvas cap', () => {
        expect(fitSize(src, { width: 0, lockAspect: true })).toEqual({ width: 1, height: 1 });
        expect(fitSize(src, { width: 100000, lockAspect: false })).toEqual({ width: 8192, height: 600 });
    });
});

describe('traceSize', () => {
    it('leaves small images alone', () => {
        expect(traceSize({ width: 300, height: 200 })).toEqual({ width: 300, height: 200 });
    });

    it('scales the long edge down to the cap, keeping the aspect', () => {
        expect(traceSize({ width: 4000, height: 2000 })).toEqual({ width: 1024, height: 512 });
        expect(traceSize({ width: 1000, height: 3000 }, 600)).toEqual({ width: 200, height: 600 });
    });
});

describe('outputFileName', () => {
    it('swaps the extension, writing jpeg as .jpg', () => {
        expect(outputFileName('logo.png', 'svg')).toBe('logo.svg');
        expect(outputFileName('photo.final.webp', 'jpeg')).toBe('photo.final.jpg');
        expect(outputFileName('favicon', 'ico')).toBe('favicon.ico');
    });

    it('falls back to "image" for a nameless paste', () => {
        expect(outputFileName('', 'png')).toBe('image.png');
        expect(outputFileName('.png', 'webp')).toBe('image.webp');
    });
});

describe('buildEmbedSvg', () => {
    it('wraps the data URL in an svg sized to the output', () => {
        const svg = buildEmbedSvg('data:image/png;base64,AAAA', 32, 16);
        expect(svg).toContain('width="32" height="16" viewBox="0 0 32 16"');
        expect(svg).toContain('href="data:image/png;base64,AAAA"');
        expect(svg).toContain('xlink:href="data:image/png;base64,AAAA"');
        expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    });
});

describe('encodeIco', () => {
    const png = (n: number) => new Uint8Array(n).fill(0xab);

    it('writes the ICONDIR header, one entry per size and the PNGs after the directory', () => {
        const ico = encodeIco([{ size: 16, png: png(10) }, { size: 256, png: png(20) }]);
        const view = new DataView(ico.buffer);

        expect(view.getUint16(0, true)).toBe(0); // reserved
        expect(view.getUint16(2, true)).toBe(1); // type: icon
        expect(view.getUint16(4, true)).toBe(2); // count

        // Entry 1 (16px) starts at 6.
        expect(ico[6]).toBe(16);
        expect(ico[7]).toBe(16);
        expect(view.getUint16(6 + 4, true)).toBe(1); // planes
        expect(view.getUint16(6 + 6, true)).toBe(32); // bit count
        expect(view.getUint32(6 + 8, true)).toBe(10); // bytes
        expect(view.getUint32(6 + 12, true)).toBe(6 + 16 * 2); // offset

        // Entry 2 (256px) is written as 0 per the format.
        expect(ico[22]).toBe(0);
        expect(ico[23]).toBe(0);
        expect(view.getUint32(22 + 12, true)).toBe(6 + 32 + 10);

        expect(ico.length).toBe(6 + 32 + 30);
        expect(ico[6 + 32]).toBe(0xab);
    });
});

describe('traceToSvg', () => {
    // 4x4: left half red, right half blue.
    const image = (() => {
        const data = new Uint8ClampedArray(4 * 4 * 4);
        for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
                const i = (y * 4 + x) * 4;
                data.set(x < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], i);
            }
        }
        return { width: 4, height: 4, data };
    })();

    it('produces vector paths sized to the requested output', () => {
        const svg = traceToSvg(image, { colors: 2, detail: 'high' }, { width: 64, height: 64 });
        expect(svg).toMatch(/^<svg width="64" height="64" viewBox="0 0 4 4"/);
        expect(svg).toContain('<path');
        expect(svg).not.toContain('desc=');
        expect(svg.endsWith('</svg>')).toBe(true);
    });
});

describe('formatBytes / sizeChange', () => {
    it('formats sizes compactly', () => {
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(2048)).toBe('2.0 KB');
        expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    });

    it('signs the change relative to the original', () => {
        expect(sizeChange(1000, 580)).toBe('-42%');
        expect(sizeChange(1000, 1500)).toBe('+50%');
        expect(sizeChange(0, 100)).toBe('');
    });
});
