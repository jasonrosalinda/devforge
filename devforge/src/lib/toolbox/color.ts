// Colour parsing / conversion and the WCAG 2.x contrast ratio.

export interface Rgb { r: number; g: number; b: number }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function hslToRgb(h: number, s: number, l: number): Rgb {
    const hue = ((h % 360) + 360) % 360;
    const sat = clamp(s, 0, 100) / 100;
    const lig = clamp(l, 0, 100) / 100;
    const c = (1 - Math.abs(2 * lig - 1)) * sat;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = lig - c / 2;
    const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x]
        : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

/** `#rgb`, `#rrggbb` (alpha in `#rrggbbaa` / `#rgba` is ignored), `rgb()/rgba()` or `hsl()/hsla()`. null when unreadable. */
export function parseColor(input: string): Rgb | null {
    const s = input.trim().toLowerCase();
    const hex = s.match(/^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
    if (hex) {
        let h = hex[1]!;
        if (h.length <= 4) h = [...h.slice(0, 3)].map(c => c + c).join('');
        return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    }
    const nums = (body: string) => body.split(/[\s,/]+/).filter(Boolean).map(v => parseFloat(v));
    const rgb = s.match(/^rgba?\(([^)]*)\)$/);
    if (rgb) {
        const [r, g, b] = nums(rgb[1]!);
        if ([r, g, b].some(v => v === undefined || Number.isNaN(v))) return null;
        return { r: clamp(Math.round(r!), 0, 255), g: clamp(Math.round(g!), 0, 255), b: clamp(Math.round(b!), 0, 255) };
    }
    const hsl = s.match(/^hsla?\(([^)]*)\)$/);
    if (hsl) {
        const [h, sat, l] = nums(hsl[1]!.replace(/%|deg/g, ''));
        if ([h, sat, l].some(v => v === undefined || Number.isNaN(v))) return null;
        return hslToRgb(h!, sat!, l!);
    }
    return null;
}

export const toHex = ({ r, g, b }: Rgb): string => `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;

export const toRgbString = ({ r, g, b }: Rgb): string => `rgb(${r}, ${g}, ${b})`;

export function toHslString({ r, g, b }: Rgb): string {
    const [rn, gn, bn] = [r / 255, g / 255, b / 255];
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (d !== 0) {
        if (max === rn) h = 60 * (((gn - bn) / d) % 6);
        else if (max === gn) h = 60 * ((bn - rn) / d + 2);
        else h = 60 * ((rn - gn) / d + 4);
    }
    return `hsl(${Math.round((h + 360) % 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance({ r, g, b }: Rgb): number {
    const ch = (v: number) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** 1 (same) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
    const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
}

/** Pass / fail per WCAG level. Large text = 18pt+, or 14pt+ bold. */
export function wcag(ratio: number) {
    return { aaNormal: ratio >= 4.5, aaLarge: ratio >= 3, aaaNormal: ratio >= 7, aaaLarge: ratio >= 4.5, uiComponents: ratio >= 3 };
}
