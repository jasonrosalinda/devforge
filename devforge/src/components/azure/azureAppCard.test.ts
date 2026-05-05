import { describe, it, expect } from 'vitest';
import { getStatus } from './azureAppCard';

describe('getStatus', () => {
  it('returns critical when cpu > 90', () => {
    expect(getStatus(91, 50)).toBe('critical');
  });
  it('returns critical when mem > 95', () => {
    expect(getStatus(50, 96)).toBe('critical');
  });
  it('returns warning when cpu > 70', () => {
    expect(getStatus(71, 50)).toBe('warning');
  });
  it('returns warning when mem > 80', () => {
    expect(getStatus(50, 81)).toBe('warning');
  });
  it('returns healthy otherwise', () => {
    expect(getStatus(50, 50)).toBe('healthy');
  });
  it('critical takes priority over warning', () => {
    expect(getStatus(91, 81)).toBe('critical');
  });
});
