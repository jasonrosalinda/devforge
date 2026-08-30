// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveCssColor, UI } from './chart-colors';

// happy-dom does not resolve custom properties, so a browser's resolution is
// stubbed where the point of the test is what comes back resolved.
const stubComputed = (color: string) =>
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ color, backgroundColor: 'rgb(9, 9, 11)' } as any);

describe('resolveCssColor', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes literal colours through untouched', () => {
    expect(resolveCssColor('#0b1220')).toBe('#0b1220');
    expect(resolveCssColor('rgb(11, 18, 32)')).toBe('rgb(11, 18, 32)');
  });

  it('flattens a custom-property colour to the resolved literal', () => {
    stubComputed('rgb(11, 18, 32)');
    expect(resolveCssColor(UI.background)).toBe('rgb(11, 18, 32)');
  });

  it('flattens an alpha-modified custom-property colour', () => {
    stubComputed('rgba(148, 163, 184, 0.7)');
    expect(resolveCssColor(UI.textDim)).toBe('rgba(148, 163, 184, 0.7)');
  });

  // html2canvas throws "Unsupported angle type" on any hsl() whose hue is still a
  // var() function token, so an unresolvable token must never be handed back as-is.
  it('never returns a var() string when resolution fails', () => {
    stubComputed('hsl(var(--background))');
    const resolved = resolveCssColor(UI.background);
    expect(resolved).not.toContain('var(');
    expect(resolved).toBe('rgb(9, 9, 11)');
  });

  it('honours an explicit fallback when resolution fails', () => {
    stubComputed('');
    expect(resolveCssColor(UI.background, '#111827')).toBe('#111827');
  });
});
