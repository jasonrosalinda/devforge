import { describe, expect, it } from 'vitest';
import { childEntries, childPath, nodeKind, nodeSummary } from './dataTree';

describe('nodeKind / nodeSummary', () => {
    it('names each kind and summarizes it', () => {
        expect([{}, [], 'x', 1, true, null, undefined].map(nodeKind)).toEqual(['object', 'array', 'string', 'number', 'boolean', 'null', 'null']);
        expect(nodeSummary({ a: 1, b: 2 })).toBe('2 keys');
        expect(nodeSummary({ a: 1 })).toBe('1 key');
        expect(nodeSummary([1])).toBe('1 item');
        expect(nodeSummary([])).toBe('0 items');
        expect(nodeSummary('hi "x"')).toBe('"hi \\"x\\""');
        expect(nodeSummary(3.5)).toBe('3.5');
        expect(nodeSummary(null)).toBe('null');
    });
});

describe('childEntries', () => {
    it('lists object keys and array indexes, capped with a remainder', () => {
        expect(childEntries({ a: 1, b: [2] })).toEqual({ entries: [['a', 1], ['b', [2]]], more: 0 });
        expect(childEntries(['x', 'y', 'z'], 2)).toEqual({ entries: [['0', 'x'], ['1', 'y']], more: 1 });
        expect(childEntries('scalar')).toEqual({ entries: [], more: 0 });
    });
});

describe('childPath', () => {
    it('builds dot, index and quoted paths', () => {
        expect(childPath('', 'spec', false)).toBe('spec');
        expect(childPath('spec', 'containers', false)).toBe('spec.containers');
        expect(childPath('spec.containers', '0', true)).toBe('spec.containers[0]');
        expect(childPath('root', '@id', false)).toBe('root.@id');
        expect(childPath('headers', 'Content Type', false)).toBe('headers["Content Type"]');
        expect(childPath('', '1st', false)).toBe('["1st"]');
    });
});
