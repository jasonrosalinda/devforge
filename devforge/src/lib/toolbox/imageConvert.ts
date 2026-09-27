import ImageTracer from 'imagetracerjs';

export type OutputFormat = 'png' | 'jpeg' | 'webp' | 'ico' | 'svg';

export const OUTPUT_FORMATS: { value: OutputFormat; label: string; mime: string; ext: string; lossy: boolean }[] = [
    { value: 'png', label: 'PNG', mime: 'image/png', ext: 'png', lossy: false },
    { value: 'jpeg', label: 'JPEG', mime: 'image/jpeg', ext: 'jpg', lossy: true },
    { value: 'webp', label: 'WebP', mime: 'image/webp', ext: 'webp', lossy: true },
    { value: 'ico', label: 'ICO', mime: 'image/x-icon', ext: 'ico', lossy: false },
    { value: 'svg', label: 'SVG', mime: 'image/svg+xml', ext: 'svg', lossy: false },
];

export const ICO_SIZES = [16, 32, 48, 256] as const;

export type Size = { width: number; height: number };

/** Chromium refuses canvases much past this on either side. */
const MAX_DIMENSION = 8192;

const clampDim = (n: number) => Math.min(MAX_DIMENSION, Math.max(1, Math.round(n)));
const typed = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n : undefined);

/**
 * Output size from the resize inputs. A blank side follows the source; with the
 * aspect locked, the side typed drives the other (width wins if both are typed).
 */
export function fitSize(src: Size, target: { width?: number | undefined; height?: number | undefined; lockAspect: boolean }): Size {
    const width = typed(target.width);
    const height = typed(target.height);

    if (target.lockAspect) {
        if (width !== undefined) return { width: clampDim(width), height: clampDim((width * src.height) / src.width) };
        if (height !== undefined) return { width: clampDim((height * src.width) / src.height), height: clampDim(height) };
    }
    return { width: clampDim(width ?? src.width), height: clampDim(height ?? src.height) };
}

/** Tracing time grows with pixel count; trace a copy no longer than `max` on its long edge. */
export function traceSize(size: Size, max = 1024): Size {
    const long = Math.max(size.width, size.height);
    if (long <= max) return size;
    const scale = max / long;
    return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

export function outputFileName(inputName: string, format: OutputFormat): string {
    const base = inputName.replace(/\.[^./\\]*$/, '') || 'image';
    return `${base}.${OUTPUT_FORMATS.find((f) => f.value === format)!.ext}`;
}

/** The exact pixels inside an <svg>. `xlink:href` rides along for editors that predate plain `href`. */
export function buildEmbedSvg(dataUrl: string, width: number, height: number): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
        + `<image width="${width}" height="${height}" href="${dataUrl}" xlink:href="${dataUrl}"/></svg>`;
}

/**
 * ICO container holding one PNG per size (Vista+ format, which every current
 * browser and OS reads). Width/height bytes of 0 mean 256.
 */
export function encodeIco(images: { size: number; png: Uint8Array }[]): Uint8Array<ArrayBuffer> {
    const HEADER = 6;
    const ENTRY = 16;
    const total = HEADER + ENTRY * images.length + images.reduce((sum, image) => sum + image.png.length, 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);

    view.setUint16(0, 0, true);
    view.setUint16(2, 1, true);
    view.setUint16(4, images.length, true);

    let offset = HEADER + ENTRY * images.length;
    images.forEach((image, i) => {
        const entry = HEADER + ENTRY * i;
        const side = image.size >= 256 ? 0 : image.size;
        out[entry] = side;
        out[entry + 1] = side;
        out[entry + 2] = 0; // palette colours
        out[entry + 3] = 0; // reserved
        view.setUint16(entry + 4, 1, true); // planes
        view.setUint16(entry + 6, 32, true); // bits per pixel
        view.setUint32(entry + 8, image.png.length, true);
        view.setUint32(entry + 12, offset, true);
        out.set(image.png, offset);
        offset += image.png.length;
    });

    return out;
}

export type TraceDetail = 'low' | 'medium' | 'high';

export type TraceOptions = { colors: number; detail: TraceDetail };

// ltres/qtres: error allowed before a line/curve is split; pathomit: drop paths with fewer points.
const DETAIL_PRESETS: Record<TraceDetail, Record<string, number>> = {
    low: { ltres: 2, qtres: 2, pathomit: 16 },
    medium: { ltres: 1, qtres: 1, pathomit: 8 },
    high: { ltres: 0.5, qtres: 0.5, pathomit: 0, roundcoords: 2 },
};

/**
 * Vectorises RGBA pixels. The paths stay in the traced image's coordinates (its
 * viewBox) while width/height are set to `output`, so a downscaled trace still
 * renders at full size.
 */
export function traceToSvg(image: { width: number; height: number; data: ArrayLike<number> }, options: TraceOptions, output: Size): string {
    const svg = ImageTracer.imagedataToSVG(image, {
        ...DETAIL_PRESETS[options.detail],
        numberofcolors: Math.max(2, Math.round(options.colors)),
        viewbox: true,
    });
    return svg
        .replace(/^<svg /, `<svg width="${output.width}" height="${output.height}" `)
        .replace(/ desc="[^"]*"/, '');
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function sizeChange(before: number, after: number): string {
    if (!before) return '';
    const pct = Math.round(((after - before) / before) * 100);
    return `${pct > 0 ? '+' : ''}${pct}%`;
}
