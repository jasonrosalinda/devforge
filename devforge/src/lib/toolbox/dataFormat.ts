import { parse as parseYaml, stringify as stringifyYaml, YAMLParseError } from 'yaml';

export type DataFormat = 'json' | 'yaml' | 'xml';

export type FormatIssue = { message: string; line?: number; column?: number };

export type ParseResult = {
    value: unknown;
    error: FormatIssue | null;
    /** Lossy mappings the caller should surface, e.g. XML attributes. */
    warnings: string[];
};

export type FormatResult = { output: string; error: FormatIssue | null; warnings: string[] };

export const DATA_FORMATS: DataFormat[] = ['json', 'yaml', 'xml'];

const INDENT = '  ';

/** Prefix used for XML attributes once they are flattened into an object. */
const ATTRIBUTE_PREFIX = '@';

export function detectFormat(text: string): DataFormat | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('<')) return 'xml';
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
    return 'yaml';
}

function lineAndColumn(text: string, position: number): { line: number; column: number } {
    const upTo = text.slice(0, position);
    const lines = upTo.split('\n');
    return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

function parseJson(text: string): ParseResult {
    try {
        return { value: JSON.parse(text), error: null, warnings: [] };
    } catch (error) {
        const message = (error as Error).message;
        // V8 reports the byte offset; turning it into line/column is what makes
        // the message usable against a large config file.
        const position = /position (\d+)/.exec(message)?.[1];
        const location = position === undefined ? {} : lineAndColumn(text, Number(position));
        return { value: null, error: { message, ...location }, warnings: [] };
    }
}

function parseYamlText(text: string): ParseResult {
    try {
        return { value: parseYaml(text) ?? null, error: null, warnings: [] };
    } catch (error) {
        if (error instanceof YAMLParseError) {
            const position = error.linePos?.[0];
            const location = position ? { line: position.line, column: position.col } : {};
            return { value: null, error: { message: error.message, ...location }, warnings: [] };
        }
        return { value: null, error: { message: (error as Error).message }, warnings: [] };
    }
}

function elementToValue(element: Element, warnings: Set<string>): unknown {
    const attributes = [...element.attributes];
    const childElements = [...element.children];

    if (attributes.length) {
        warnings.add(`XML attributes were mapped to "${ATTRIBUTE_PREFIX}name" keys; converting back will not restore them as attributes.`);
    }

    if (!childElements.length && !attributes.length) {
        const text = element.textContent ?? '';
        return text === '' ? null : text;
    }

    const result: Record<string, unknown> = {};
    for (const attribute of attributes) {
        result[`${ATTRIBUTE_PREFIX}${attribute.name}`] = attribute.value;
    }

    if (!childElements.length) {
        const text = element.textContent ?? '';
        if (text !== '') result['#text'] = text;
        return result;
    }

    for (const child of childElements) {
        const value = elementToValue(child, warnings);
        const existing = result[child.tagName];
        if (existing === undefined) {
            result[child.tagName] = value;
        } else if (Array.isArray(existing)) {
            existing.push(value);
        } else {
            result[child.tagName] = [existing, value];
        }
    }

    return result;
}

function parseXml(text: string): ParseResult {
    const document = new DOMParser().parseFromString(text, 'application/xml');
    const failure = document.querySelector('parsererror');
    if (failure) {
        return { value: null, error: { message: failure.textContent?.trim() || 'The XML could not be parsed.' }, warnings: [] };
    }

    const root = document.documentElement;
    if (!root) return { value: null, error: { message: 'The XML has no root element.' }, warnings: [] };

    const warnings = new Set<string>();
    return { value: { [root.tagName]: elementToValue(root, warnings) }, error: null, warnings: [...warnings] };
}

export function parseData(text: string, format: DataFormat): ParseResult {
    if (format === 'json') return parseJson(text);
    if (format === 'yaml') return parseYamlText(text);
    return parseXml(text);
}

function escapeXmlText(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value: string): string {
    return escapeXmlText(value).replace(/"/g, '&quot;');
}

/** A tag name XML will accept; keys that are not valid element names become `item`. */
function safeTagName(key: string): string {
    return /^[A-Za-z_][\w.-]*$/.test(key) ? key : 'item';
}

function valueToXml(key: string, value: unknown, depth: number): string[] {
    const pad = INDENT.repeat(depth);
    const tag = safeTagName(key);

    if (Array.isArray(value)) {
        return value.flatMap((entry) => valueToXml(key, entry, depth));
    }

    if (value === null || value === undefined) {
        return [`${pad}<${tag}/>`];
    }

    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>);
        const attributes = entries
            .filter(([name]) => name.startsWith(ATTRIBUTE_PREFIX))
            .map(([name, attributeValue]) => ` ${safeTagName(name.slice(1))}="${escapeXmlAttribute(String(attributeValue))}"`)
            .join('');
        const children = entries.filter(([name]) => !name.startsWith(ATTRIBUTE_PREFIX));

        if (!children.length) return [`${pad}<${tag}${attributes}/>`];

        return [
            `${pad}<${tag}${attributes}>`,
            ...children.flatMap(([childKey, childValue]) => valueToXml(childKey, childValue, depth + 1)),
            `${pad}</${tag}>`,
        ];
    }

    return [`${pad}<${tag}>${escapeXmlText(String(value))}</${tag}>`];
}

export function stringifyData(value: unknown, format: DataFormat, options: { minify?: boolean } = {}): string {
    if (format === 'json') return JSON.stringify(value, null, options.minify ? undefined : 2);
    if (format === 'yaml') return stringifyYaml(value);

    // XML needs exactly one root element. A document that already looks like
    // one — a single key wrapping an object, which is what parsing XML gives
    // back — keeps its own name; anything else gets a supplied <root>.
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const entries = Object.entries(value as Record<string, unknown>);
        const [onlyKey, onlyValue] = entries[0] ?? [];
        if (
            entries.length === 1 &&
            !onlyKey!.startsWith(ATTRIBUTE_PREFIX) &&
            onlyValue !== null &&
            typeof onlyValue === 'object' &&
            !Array.isArray(onlyValue)
        ) {
            return valueToXml(onlyKey!, onlyValue, 0).join('\n');
        }
    }

    // A bare array has no element name to repeat, so its entries become <item>.
    if (Array.isArray(value)) {
        return ['<root>', ...value.flatMap((entry) => valueToXml('item', entry, 1)), '</root>'].join('\n');
    }

    return valueToXml('root', value, 0).join('\n');
}

function serialiseElement(element: Element, depth: number): string[] {
    const pad = INDENT.repeat(depth);
    const attributes = [...element.attributes]
        .map((attribute) => ` ${attribute.name}="${escapeXmlAttribute(attribute.value)}"`)
        .join('');
    const childElements = [...element.children];

    if (!childElements.length) {
        const text = element.textContent ?? '';
        if (text === '') return [`${pad}<${element.tagName}${attributes}/>`];
        return [`${pad}<${element.tagName}${attributes}>${escapeXmlText(text)}</${element.tagName}>`];
    }

    return [
        `${pad}<${element.tagName}${attributes}>`,
        ...childElements.flatMap((child) => serialiseElement(child, depth + 1)),
        `${pad}</${element.tagName}>`,
    ];
}

function formatXml(text: string): FormatResult {
    const document = new DOMParser().parseFromString(text, 'application/xml');
    const failure = document.querySelector('parsererror');
    if (failure) {
        return { output: '', error: { message: failure.textContent?.trim() || 'The XML could not be parsed.' }, warnings: [] };
    }
    if (!document.documentElement) {
        return { output: '', error: { message: 'The XML has no root element.' }, warnings: [] };
    }

    const declaration = /^\s*(<\?xml[^?]*\?>)/.exec(text)?.[1];
    const body = serialiseElement(document.documentElement, 0).join('\n');

    return { output: declaration ? `${declaration}\n${body}` : body, error: null, warnings: [] };
}

/** Pretty-prints or minifies without changing format. */
export function formatData(text: string, format: DataFormat, options: { minify?: boolean } = {}): FormatResult {
    if (format === 'xml') {
        // Minifying XML would need whitespace-significance rules that a general
        // formatter cannot infer, so XML is only ever pretty-printed.
        return formatXml(text);
    }

    const parsed = parseData(text, format);
    if (parsed.error) return { output: '', error: parsed.error, warnings: parsed.warnings };

    return { output: stringifyData(parsed.value, format, options), error: null, warnings: parsed.warnings };
}

export function convertData(
    text: string,
    from: DataFormat,
    to: DataFormat,
    options: { minify?: boolean } = {},
): FormatResult {
    if (from === to) return formatData(text, to, options);

    const parsed = parseData(text, from);
    if (parsed.error) return { output: '', error: parsed.error, warnings: parsed.warnings };

    return { output: stringifyData(parsed.value, to, options), error: null, warnings: parsed.warnings };
}
