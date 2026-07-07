import type { ScannedFile, ScanResult, UnusedAsset } from "@/types/unusedAssets.types";

export function assetId(asset: UnusedAsset): string {
    return `${asset.kind}:${asset.name}:${asset.file}:${asset.line}`;
}

export function displayName(asset: UnusedAsset): string {
    if (asset.kind === "css-class") return `.${asset.name}`;
    if (asset.kind === "css-id") return `#${asset.name}`;
    return asset.name;
}

const IGNORE_DIRS = new Set([
    "node_modules", "bin", "obj", ".git", ".vs", ".test-fixture", "dist", "build",
    ".github", ".agents", "worktrees", "graphify-out", "artifacts", "Assemblies", ".upgrade-script",
]);

const VENDOR_PATH_FRAGMENTS = [
    "wwwroot/lib", "wwwroot/bootstrap", "wwwroot/jquery", "wwwroot/pinegrow",
    "/bootstrap/", "/syncfusion/", "/open-iconic/", "nanobar.min", "detectincognito",
    "popper.min", "/decode.", "/fontawesome/", "font-awesome",
];

function normalizePath(path: string): string {
    return path.replace(/\\/g, "/");
}

function isVendor(path: string): boolean {
    const normalized = normalizePath(path).toLowerCase();
    return VENDOR_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function isGenerated(path: string): boolean {
    return /\.g\.cs$|\.designer\.cs$/i.test(path);
}

function isMinified(path: string): boolean {
    return /\.min\.[jt]sx?$/i.test(path);
}

export function shouldIgnorePath(relativePath: string): boolean {
    const parts = normalizePath(relativePath).split("/");
    if (parts.some((p) => IGNORE_DIRS.has(p))) return true;
    if (isVendor(relativePath)) return true;
    if (isGenerated(relativePath)) return true;
    if (isMinified(relativePath)) return true;
    return false;
}

function isCssFile(path: string): boolean {
    return /\.(css|scss|sass|less)$/i.test(path);
}

function isJsFile(path: string): boolean {
    return /\.(js|ts|jsx|tsx)$/i.test(path);
}

function isCsFile(path: string): boolean {
    return /\.cs$/i.test(path);
}

export function isScannableFile(path: string): boolean {
    return isCssFile(path) || isJsFile(path) || isCsFile(path) || /\.(razor|cshtml|html|htm)$/i.test(path);
}

function lineAt(content: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index && i < content.length; i++) {
        if (content.charCodeAt(i) === 10) line++;
    }
    return line;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CssDefRecord {
    file: string;
    line: number;
    defCount: number;
    standaloneCount: number;
}

const RE_CSS_CLASS = /\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g;
const RE_CSS_ID = /#([a-zA-Z_][a-zA-Z0-9_-]*)/g;
const RE_PSEUDO = /::[a-z-]+|:[a-z-]+(\([^)]*\))?/gi;
const RE_AT_RULE = /^\s*@[a-zA-Z]/;

function stripLineComment(line: string, state: { inComment: boolean }): string {
    let result = "";
    let idx = 0;
    while (idx < line.length) {
        if (state.inComment) {
            const end = line.indexOf("*/", idx);
            if (end === -1) return result;
            state.inComment = false;
            idx = end + 2;
            continue;
        }
        const blockStart = line.indexOf("/*", idx);
        const lineStart = line.indexOf("//", idx);
        if (lineStart !== -1 && (blockStart === -1 || lineStart < blockStart)) {
            result += line.slice(idx, lineStart);
            return result;
        }
        if (blockStart !== -1) {
            result += line.slice(idx, blockStart);
            const end = line.indexOf("*/", blockStart + 2);
            if (end === -1) {
                state.inComment = true;
                return result;
            }
            idx = end + 2;
            continue;
        }
        result += line.slice(idx);
        return result;
    }
    return result;
}

function collectCssDefs(
    file: ScannedFile,
    classDefs: Map<string, CssDefRecord>,
    idDefs: Map<string, CssDefRecord>
): void {
    const lines = file.content.split(/\r\n|\n/);
    const commentState = { inComment: false };
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
        const depthBefore = braceDepth;
        const line = stripLineComment(lines[i] ?? "", commentState);
        const braceOpens = (line.match(/\{/g) ?? []).length;
        const braceCloses = (line.match(/\}/g) ?? []).length;
        braceDepth += braceOpens - braceCloses;

        const hasBrace = line.includes("{");
        if (depthBefore > 0 && !hasBrace) continue;
        if (RE_AT_RULE.test(line)) continue;

        const selectorPart = (hasBrace ? line.slice(0, line.indexOf("{")) : line).replace(RE_PSEUDO, "");
        if (!selectorPart.trim()) continue;

        for (const selector of selectorPart.split(",")) {
            const simpleParts = selector.split(/[\s>+~]+/).filter(Boolean);
            for (const part of simpleParts) {
                const classMatches = [...part.matchAll(RE_CSS_CLASS)].map((m) => m[1]!);
                const idMatches = [...part.matchAll(RE_CSS_ID)].map((m) => m[1]!);
                const standalone = classMatches.length === 1 && idMatches.length === 0;

                for (const name of classMatches) {
                    const existing = classDefs.get(name);
                    if (existing) {
                        existing.defCount++;
                        if (standalone) existing.standaloneCount++;
                    } else {
                        classDefs.set(name, {
                            file: file.path,
                            line: i + 1,
                            defCount: 1,
                            standaloneCount: standalone ? 1 : 0,
                        });
                    }
                }
                for (const name of idMatches) {
                    const existing = idDefs.get(name);
                    if (existing) existing.defCount++;
                    else idDefs.set(name, { file: file.path, line: i + 1, defCount: 1, standaloneCount: 1 });
                }
            }
        }
    }
}

interface JsDefRecord {
    file: string;
    line: number;
}

const JS_DEF_PATTERNS: RegExp[] = [
    /\bfunction\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:function\b|\([^)]*\)\s*=>|[a-zA-Z_$][a-zA-Z0-9_$]*\s*=>)/g,
    /\bwindow\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:function\b|(?:[a-zA-Z_$][a-zA-Z0-9_$]*\s*=>|\([^)]*\)\s*=>))/g,
    /\bexport\s+(?:default\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
    /\bexport\s+(?:const|let)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g,
    /^\s{2,}([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*\{/gm,
];

const RE_WINDOW_NS = /\bwindow((?:\.[a-zA-Z_$][a-zA-Z0-9_$]*){2,})\s*=/g;

function collectJsDefs(file: ScannedFile, defs: Map<string, JsDefRecord>): void {
    for (const pattern of JS_DEF_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(file.content))) {
            const name = match[1]!;
            if (name.length > 2 && !defs.has(name)) {
                defs.set(name, { file: file.path, line: lineAt(file.content, match.index) });
            }
        }
    }

    RE_WINDOW_NS.lastIndex = 0;
    let nsMatch: RegExpExecArray | null;
    while ((nsMatch = RE_WINDOW_NS.exec(file.content))) {
        const path = nsMatch[1]!.slice(1);
        const segments = path.split(".");
        const last = segments[segments.length - 1]!;
        const line = lineAt(file.content, nsMatch.index);
        if (!defs.has(path)) defs.set(path, { file: file.path, line });
        if (last.length > 2 && !defs.has(last)) defs.set(last, { file: file.path, line });
    }
}

const RE_JSINVOKABLE =
    /\[JSInvokable(?:\("([^"]+)"\))?\][\s\S]{0,200}?(?:public|private|internal|protected)\s+(?:static\s+)?[a-zA-Z<>[\],?\s]+\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;

function collectJsInvokableDefs(file: ScannedFile, defs: Map<string, JsDefRecord>): void {
    RE_JSINVOKABLE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RE_JSINVOKABLE.exec(file.content))) {
        const name = match[1] ?? match[2]!;
        if (!defs.has(name)) {
            defs.set(name, { file: file.path, line: lineAt(file.content, match.index) });
        }
    }
}

interface UsageResult {
    classUsed: Set<string>;
    idUsed: Set<string>;
    dynPrefixes: Set<string>;
    jsFnUsed: Set<string>;
    dotNetInvoked: Set<string>;
}

const RE_CLASS_ATTR =
    /class(?:Name)?="([^"]*?)"|Class(?:Name)?="([^"]*?)"|CssClass="([^"]*?)"|AdditionalAttributes[^"]*"([^"]*?)"|(?:Leading|Trailing)IconCss="([^"]*?)"|IconCss="([^"]*?)"/g;
const RE_ID_ATTR = /\bid="([^"]*?)"/g;
const RE_TERNARY_CLASS = /class(?:Name)?="@\(([^)]+)\)"/g;
const RE_CSS_BUILDER_CLASS = /(?:new\s+CssBuilder|\.Add(?:Class)?)\s*\(\s*"([^"]+)"/g;
const RE_CONST_STRING_CLASS = /public\s+(?:static\s+)?const\s+string\s+\w+\s*=\s*"([^"]+)"/g;
const RE_JS_CLASS_HELPER_LINE = /\b(?:clsx|classnames|cn|classList\.add|classList\.toggle|classList\.remove)\s*\(/;
const RE_QUOTED_LITERAL = /["'`]([^"'`]+)["'`]/g;

const RE_DYN_CS = [
    /\$"[^"]*\{/,
    /"[^"]*"\s*\+/,
    /\b(?:string|String)\.(?:Format|Concat)\s*\(/,
    /\bStringBuilder\b|\.Append\s*\(/,
    /\.ToString\(\)\.ToLower\(\)/,
    /\bCssBuilder\b|\bBuildCssClass\b|classList\.add\s*\(/,
];
const RE_DYN_JS = [/`[^`]*\$\{/, /['"][^'"]*['"]\s*\+/, /\bclsx\s*\(/];
const RE_PREFIX_CS = /["'][a-zA-Z][a-zA-Z0-9]*-/g;
const RE_PREFIX_JS = /['"`][a-zA-Z][a-zA-Z0-9]*-/g;

const RE_JSINTEROP_PLAIN = /InvokeAsync[^(]*\(\s*"([^"]+)"/g;
const RE_JSINTEROP_VOID = /InvokeVoidAsync\s*\(\s*"([^"]+)"/g;
const RE_JSINTEROP_MODULE_FN = /\.InvokeAsync[^(]*\(\s*"([^"]+)"/g;
const RE_DOTNET_INVOKE =
    /(?:DotNet\.invokeMethodAsync|invokeMethodAsync)\s*\(\s*(?:'[^']*'|"[^"]*")\s*,\s*['"]([^'"]+)['"]/g;

function addClassTokens(value: string, set: Set<string>): void {
    for (const token of value.split(/\s+/)) {
        if (token) set.add(token);
    }
}

function extractPrefixes(line: string, regex: RegExp, into: Set<string>): void {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line))) {
        const raw = match[0]!;
        const prefix = raw.slice(1, -1);
        if (prefix) into.add(prefix);
    }
}

function analyzeUsage(files: ScannedFile[], jsDefs: Map<string, JsDefRecord>): UsageResult {
    const classUsed = new Set<string>();
    const idUsed = new Set<string>();
    const dynPrefixes = new Set<string>();
    const jsFnUsed = new Set<string>();
    const dotNetInvoked = new Set<string>();

    for (const file of files) {
        const content = file.content;
        const isCs = isCsFile(file.path);
        const isJs = isJsFile(file.path);

        RE_CLASS_ATTR.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = RE_CLASS_ATTR.exec(content))) {
            const value = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6];
            if (value) addClassTokens(value, classUsed);
        }

        RE_ID_ATTR.lastIndex = 0;
        while ((m = RE_ID_ATTR.exec(content))) {
            if (m[1]) idUsed.add(m[1]);
        }

        RE_TERNARY_CLASS.lastIndex = 0;
        while ((m = RE_TERNARY_CLASS.exec(content))) {
            const expr = m[1]!;
            RE_QUOTED_LITERAL.lastIndex = 0;
            let lit: RegExpExecArray | null;
            while ((lit = RE_QUOTED_LITERAL.exec(expr))) {
                addClassTokens(lit[1]!, classUsed);
            }
        }

        RE_CSS_BUILDER_CLASS.lastIndex = 0;
        while ((m = RE_CSS_BUILDER_CLASS.exec(content))) {
            addClassTokens(m[1]!, classUsed);
        }

        if (isCs) {
            RE_CONST_STRING_CLASS.lastIndex = 0;
            while ((m = RE_CONST_STRING_CLASS.exec(content))) {
                const value = m[1]!;
                if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value)) classUsed.add(value);
            }
        }

        const dynSignals = isJs ? RE_DYN_JS : isCs ? RE_DYN_CS : [];
        const prefixRegex = isJs ? RE_PREFIX_JS : RE_PREFIX_CS;
        if (dynSignals.length) {
            for (const line of content.split(/\r\n|\n/)) {
                if (dynSignals.some((re) => re.test(line))) {
                    extractPrefixes(line, prefixRegex, dynPrefixes);
                }
            }
        }

        if (isJs) {
            for (const line of content.split(/\r\n|\n/)) {
                if (RE_JS_CLASS_HELPER_LINE.test(line)) {
                    RE_QUOTED_LITERAL.lastIndex = 0;
                    let lit: RegExpExecArray | null;
                    while ((lit = RE_QUOTED_LITERAL.exec(line))) {
                        addClassTokens(lit[1]!, classUsed);
                    }
                }
            }
        }

        RE_JSINTEROP_PLAIN.lastIndex = 0;
        while ((m = RE_JSINTEROP_PLAIN.exec(content))) {
            registerInteropName(m[1]!, jsFnUsed);
        }
        RE_JSINTEROP_VOID.lastIndex = 0;
        while ((m = RE_JSINTEROP_VOID.exec(content))) {
            registerInteropName(m[1]!, jsFnUsed);
        }
        RE_JSINTEROP_MODULE_FN.lastIndex = 0;
        while ((m = RE_JSINTEROP_MODULE_FN.exec(content))) {
            registerInteropName(m[1]!, jsFnUsed);
        }

        RE_DOTNET_INVOKE.lastIndex = 0;
        while ((m = RE_DOTNET_INVOKE.exec(content))) {
            dotNetInvoked.add(m[1]!);
        }
    }

    for (const [name, def] of jsDefs) {
        const isJsFileDef = isJsFile(def.file);
        const escaped = escapeRegExp(name);
        for (const file of files) {
            if (file.path === def.file && isJsFileDef) {
                const re = new RegExp("\\b" + escaped + "\\(|<" + escaped + "\\b", "g");
                let m: RegExpExecArray | null;
                while ((m = re.exec(file.content))) {
                    if (Math.abs(lineAt(file.content, m.index) - def.line) > 2) {
                        jsFnUsed.add(name);
                        break;
                    }
                }
            } else if (isJsFile(file.path)) {
                const re = new RegExp("\\b" + escaped + "\\(|<" + escaped + "\\b");
                if (re.test(file.content)) jsFnUsed.add(name);
            } else {
                const re = new RegExp("\\b" + escaped + "\\b");
                if (re.test(file.content)) jsFnUsed.add(name);
            }
        }
    }

    return { classUsed, idUsed, dynPrefixes, jsFnUsed, dotNetInvoked };
}

function registerInteropName(raw: string, into: Set<string>): void {
    into.add(raw);
    const segments = raw.split(".");
    if (segments.length > 1) into.add(segments[segments.length - 1]!);
}

function classPrefix(name: string): string | null {
    const idx = name.indexOf("-");
    return idx > 0 ? name.slice(0, idx) : null;
}

export function runUnusedAssetsScan(files: ScannedFile[]): ScanResult {
    const cssClassDefs = new Map<string, CssDefRecord>();
    const cssIdDefs = new Map<string, CssDefRecord>();
    const jsDefs = new Map<string, JsDefRecord>();
    const jsInvokableDefs = new Map<string, JsDefRecord>();

    for (const file of files) {
        if (isCssFile(file.path)) collectCssDefs(file, cssClassDefs, cssIdDefs);
        if (isJsFile(file.path)) collectJsDefs(file, jsDefs);
        if (isCsFile(file.path)) collectJsInvokableDefs(file, jsInvokableDefs);
    }

    const usage = analyzeUsage(files, jsDefs);

    const cssUnused: UnusedAsset[] = [];
    const cssDynamic: UnusedAsset[] = [];
    for (const [name, def] of cssClassDefs) {
        const asset: UnusedAsset = { kind: "css-class", name, file: def.file, line: def.line };
        if (usage.classUsed.has(name)) continue;
        const prefix = classPrefix(name);
        if ((prefix && usage.dynPrefixes.has(prefix)) || def.standaloneCount === 0) {
            cssDynamic.push(asset);
        } else {
            cssUnused.push(asset);
        }
    }
    for (const [name, def] of cssIdDefs) {
        if (!usage.idUsed.has(name)) {
            cssUnused.push({ kind: "css-id", name, file: def.file, line: def.line });
        }
    }

    const jsUnused: UnusedAsset[] = [];
    for (const [name, def] of jsDefs) {
        if (!usage.jsFnUsed.has(name)) {
            jsUnused.push({ kind: "js-function", name, file: def.file, line: def.line });
        }
    }
    for (const [name, def] of jsInvokableDefs) {
        if (!usage.dotNetInvoked.has(name)) {
            jsUnused.push({ kind: "js-function", name, file: def.file, line: def.line });
        }
    }

    return { cssUnused, cssDynamic, jsUnused, filesScanned: files.length, filesSkipped: 0 };
}

export interface Occurrence {
    file: string;
    line: number;
    text: string;
}

const MAX_OCCURRENCES_PER_ASSET = 10;
const MAX_OCCURRENCE_LINE_LENGTH = 200;

export function findOccurrences(asset: UnusedAsset, files: ScannedFile[]): Occurrence[] {
    const found: Occurrence[] = [];
    const needle = asset.name;

    for (const file of files) {
        const lines = file.content.split(/\r\n|\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (file.path === asset.file && i + 1 === asset.line) continue;
            if (!line.includes(needle)) continue;
            found.push({
                file: file.path,
                line: i + 1,
                text: line.trim().slice(0, MAX_OCCURRENCE_LINE_LENGTH),
            });
            if (found.length >= MAX_OCCURRENCES_PER_ASSET) return found;
        }
    }
    return found;
}
