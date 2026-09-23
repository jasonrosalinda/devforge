// @vitest-environment happy-dom
// XML parsing goes through DOMParser, which only exists in a DOM environment.
import { describe, it, expect } from 'vitest';
import { parseData, stringifyData, convertData, formatData, detectFormat } from './dataFormat';

describe('detectFormat', () => {
    it('recognises JSON objects and arrays', () => {
        expect(detectFormat('  {"a":1}')).toBe('json');
        expect(detectFormat('[1,2]')).toBe('json');
    });

    it('recognises XML, skipping a declaration or comment', () => {
        expect(detectFormat('<root/>')).toBe('xml');
        expect(detectFormat('<?xml version="1.0"?><root/>')).toBe('xml');
    });

    it('falls back to YAML for anything else', () => {
        expect(detectFormat('name: devforge\nversion: 1')).toBe('yaml');
    });

    it('returns null for empty input', () => {
        expect(detectFormat('   ')).toBeNull();
    });
});

describe('parseData', () => {
    it('parses JSON', () => {
        expect(parseData('{"a":[1,2]}', 'json').value).toEqual({ a: [1, 2] });
    });

    it('reports the line and column of malformed JSON', () => {
        const result = parseData('{\n  "a": 1,\n  bad\n}', 'json');

        expect(result.value).toBeNull();
        expect(result.error?.line).toBe(3);
        expect(result.error?.column).toBeGreaterThan(0);
    });

    it('parses YAML', () => {
        expect(parseData('trigger:\n  - main\npool:\n  vmImage: ubuntu-latest', 'yaml').value).toEqual({
            trigger: ['main'],
            pool: { vmImage: 'ubuntu-latest' },
        });
    });

    it('reports the line of malformed YAML', () => {
        const result = parseData('a: 1\n b: [unclosed', 'yaml');

        expect(result.error).not.toBeNull();
        expect(result.error?.line).toBeGreaterThan(0);
    });

    it('parses XML elements into nested objects', () => {
        expect(parseData('<root><name>devforge</name><ok>true</ok></root>', 'xml').value)
            .toEqual({ root: { name: 'devforge', ok: 'true' } });
    });

    it('collects repeated XML elements into an array', () => {
        expect(parseData('<root><item>a</item><item>b</item></root>', 'xml').value)
            .toEqual({ root: { item: ['a', 'b'] } });
    });

    // Attributes have no natural JSON equivalent, so the mapping is stated
    // rather than silently applied.
    it('maps XML attributes to @-prefixed keys and warns that it did', () => {
        const result = parseData('<root id="7"><child/></root>', 'xml');

        expect(result.value).toEqual({ root: { '@id': '7', child: null } });
        expect(result.warnings.join(' ')).toMatch(/attribute/i);
    });

    it('reports malformed XML instead of returning a parser-error document', () => {
        const result = parseData('<root><unclosed></root>', 'xml');

        expect(result.value).toBeNull();
        expect(result.error).not.toBeNull();
    });
});

describe('formatData', () => {
    it('pretty-prints JSON with two-space indentation', () => {
        expect(formatData('{"a":1}', 'json').output).toBe('{\n  "a": 1\n}');
    });

    it('minifies JSON on request', () => {
        expect(formatData('{\n  "a": 1\n}', 'json', { minify: true }).output).toBe('{"a":1}');
    });

    it('pretty-prints nested and self-closing XML', () => {
        const result = formatData('<a><b x="1"/><c>text</c></a>', 'xml');

        expect(result.output).toBe('<a>\n  <b x="1"/>\n  <c>text</c>\n</a>');
    });

    it('keeps the XML declaration when there is one', () => {
        const result = formatData('<?xml version="1.0" encoding="utf-8"?><a><b/></a>', 'xml');

        expect(result.output).toBe('<?xml version="1.0" encoding="utf-8"?>\n<a>\n  <b/>\n</a>');
    });

    it('returns the error and no output for invalid input', () => {
        const result = formatData('{nope}', 'json');

        expect(result.output).toBe('');
        expect(result.error).not.toBeNull();
    });
});

describe('convertData', () => {
    it('round-trips JSON through YAML without losing values', () => {
        const source = '{"name":"devforge","tags":["a","b"],"nested":{"n":1,"flag":false},"empty":null}';

        const yaml = convertData(source, 'json', 'yaml');
        const back = convertData(yaml.output, 'yaml', 'json');

        expect(JSON.parse(back.output)).toEqual(JSON.parse(source));
    });

    it('converts YAML to JSON', () => {
        const result = convertData('name: devforge\nport: 5173', 'yaml', 'json');

        expect(JSON.parse(result.output)).toEqual({ name: 'devforge', port: 5173 });
    });

    it('wraps a JSON object in a root element when converting to XML', () => {
        const result = convertData('{"name":"devforge"}', 'json', 'xml');

        expect(result.output).toBe('<root>\n  <name>devforge</name>\n</root>');
    });

    it('escapes markup characters when converting to XML', () => {
        const result = convertData('{"note":"a < b & c"}', 'json', 'xml');

        expect(result.output).toContain('a &lt; b &amp; c');
    });

    it('carries parse warnings through the conversion', () => {
        const result = convertData('<root id="7"><a>1</a></root>', 'xml', 'json');

        expect(result.warnings.length).toBeGreaterThan(0);
        expect(JSON.parse(result.output)).toEqual({ root: { '@id': '7', a: '1' } });
    });

    it('reports the source error and produces no output when parsing fails', () => {
        const result = convertData('{bad', 'json', 'yaml');

        expect(result.output).toBe('');
        expect(result.error).not.toBeNull();
    });
});

describe('stringifyData', () => {
    it('renders an array to YAML', () => {
        expect(stringifyData(['a', 'b'], 'yaml').trim()).toBe('- a\n- b');
    });

    it('renders a scalar to XML inside the root element', () => {
        expect(stringifyData('hello', 'xml')).toBe('<root>hello</root>');
    });

    it('renders an array to XML as repeated item elements', () => {
        expect(stringifyData(['a', 'b'], 'xml')).toBe('<root>\n  <item>a</item>\n  <item>b</item>\n</root>');
    });
});
