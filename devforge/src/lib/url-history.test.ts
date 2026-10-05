// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadUrlHistory, pushUrlHistory } from './url-history';

const KEY = 'test:urls';

describe('url history', () => {
  beforeEach(() => localStorage.clear());

  it('is empty when nothing was saved', () => {
    expect(loadUrlHistory(KEY)).toEqual([]);
  });

  it('puts the latest URL first and keeps one copy of a repeat', () => {
    pushUrlHistory(KEY, 'https://a');
    pushUrlHistory(KEY, 'https://b');
    expect(pushUrlHistory(KEY, 'https://a')).toEqual(['https://a', 'https://b']);
    expect(loadUrlHistory(KEY)).toEqual(['https://a', 'https://b']);
  });

  it('keeps the 20 most recent URLs', () => {
    for (let i = 0; i < 25; i++) pushUrlHistory(KEY, `https://u${i}`);
    const saved = loadUrlHistory(KEY);
    expect(saved.length).toBe(20);
    expect(saved[0]).toBe('https://u24');
    expect(saved[19]).toBe('https://u5');
  });

  it('ignores corrupt or non-string entries', () => {
    localStorage.setItem(KEY, '{not json');
    expect(loadUrlHistory(KEY)).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify(['https://a', 3, null]));
    expect(loadUrlHistory(KEY)).toEqual(['https://a']);
    localStorage.setItem(KEY, JSON.stringify({ a: 1 }));
    expect(loadUrlHistory(KEY)).toEqual([]);
  });
});
