import { describe, expect, it } from 'vitest';
import { contrastRatio, parseColor, toHex, toHslString, toRgbString, wcag } from './color';

describe('parseColor', () => {
    it('reads hex, rgb and hsl forms', () => {
        expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
        expect(parseColor('1a2B3c')).toEqual({ r: 26, g: 43, b: 60 });
        expect(parseColor('#1a2b3c80')).toEqual({ r: 26, g: 43, b: 60 });
        expect(parseColor('rgb(10, 20, 300)')).toEqual({ r: 10, g: 20, b: 255 });
        expect(parseColor('rgba(10 20 30 / 0.5)')).toEqual({ r: 10, g: 20, b: 30 });
        expect(parseColor('hsl(120, 100%, 25%)')).toEqual({ r: 0, g: 128, b: 0 });
        expect(parseColor('hsl(0deg 0% 100%)')).toEqual({ r: 255, g: 255, b: 255 });
    });

    it('returns null for anything else', () => {
        expect(parseColor('')).toBeNull();
        expect(parseColor('#12')).toBeNull();
        expect(parseColor('rgb(1,2)')).toBeNull();
        expect(parseColor('red')).toBeNull();
    });
});

describe('conversions', () => {
    it('round-trips through hex, rgb and hsl', () => {
        const c = { r: 59, g: 130, b: 246 };
        expect(toHex(c)).toBe('#3b82f6');
        expect(toRgbString(c)).toBe('rgb(59, 130, 246)');
        expect(toHslString(c)).toBe('hsl(217, 91%, 60%)');
        expect(parseColor(toHslString({ r: 0, g: 128, b: 0 }))).toEqual({ r: 0, g: 128, b: 0 });
    });
});

describe('contrast', () => {
    it('matches the WCAG reference values', () => {
        const black = { r: 0, g: 0, b: 0 };
        const white = { r: 255, g: 255, b: 255 };
        expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
        expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
        expect(contrastRatio(white, white)).toBe(1);
        expect(contrastRatio(parseColor('#767676')!, white)).toBeCloseTo(4.54, 2);
    });

    it('applies the AA / AAA thresholds', () => {
        expect(wcag(4.5)).toEqual({ aaNormal: true, aaLarge: true, aaaNormal: false, aaaLarge: true, uiComponents: true });
        expect(wcag(3)).toEqual({ aaNormal: false, aaLarge: true, aaaNormal: false, aaaLarge: false, uiComponents: true });
        expect(wcag(2.9).aaLarge).toBe(false);
        expect(wcag(7).aaaNormal).toBe(true);
    });
});
