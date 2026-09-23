export type DiffType = 'same' | 'add' | 'del';

export type DiffRow = {
    type: DiffType;
    /** 1-based line number on the left side, or null for an addition. */
    leftLine: number | null;
    /** 1-based line number on the right side, or null for a deletion. */
    rightLine: number | null;
    text: string;
};

export type DiffOptions = {
    ignoreWhitespace?: boolean;
    ignoreCase?: boolean;
    maxLines?: number;
};

export type DiffStats = { added: number; removed: number; unchanged: number };

export type DiffResult = {
    rows: DiffRow[];
    stats: DiffStats;
    /** True when either side was cut to maxLines before comparing. */
    truncated: boolean;
};

/** The comparison is O(n·m) in the worst case; this keeps a paste from freezing the tab. */
export const DEFAULT_MAX_LINES = 2000;

function normalise(line: string, options: DiffOptions): string {
    let value = line;
    if (options.ignoreWhitespace) value = value.trim().replace(/\s+/g, ' ');
    if (options.ignoreCase) value = value.toLowerCase();
    return value;
}

/**
 * Line diff via an LCS table. Common head and tail lines are matched off first,
 * so the quadratic table only ever covers the part that actually differs —
 * which for two revisions of the same file is usually a handful of lines.
 */
export function diffLines(left: string, right: string, options: DiffOptions = {}): DiffResult {
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;

    const splitLines = (text: string) => (text === '' ? [] : text.split(/\r?\n/));
    const allLeft = splitLines(left);
    const allRight = splitLines(right);

    const truncated = allLeft.length > maxLines || allRight.length > maxLines;
    const leftLines = allLeft.slice(0, maxLines);
    const rightLines = allRight.slice(0, maxLines);

    const leftKeys = leftLines.map((line) => normalise(line, options));
    const rightKeys = rightLines.map((line) => normalise(line, options));

    let head = 0;
    while (head < leftKeys.length && head < rightKeys.length && leftKeys[head] === rightKeys[head]) head += 1;

    let tail = 0;
    while (
        tail < leftKeys.length - head &&
        tail < rightKeys.length - head &&
        leftKeys[leftKeys.length - 1 - tail] === rightKeys[rightKeys.length - 1 - tail]
    ) {
        tail += 1;
    }

    const midLeft = leftKeys.slice(head, leftKeys.length - tail);
    const midRight = rightKeys.slice(head, rightKeys.length - tail);

    // lcs[i][j] = length of the longest common subsequence of midLeft[i..] and midRight[j..].
    const width = midRight.length + 1;
    const lcs = new Uint32Array((midLeft.length + 1) * width);
    for (let i = midLeft.length - 1; i >= 0; i -= 1) {
        for (let j = midRight.length - 1; j >= 0; j -= 1) {
            lcs[i * width + j] = midLeft[i] === midRight[j]
                ? lcs[(i + 1) * width + j + 1]! + 1
                : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
        }
    }

    const rows: DiffRow[] = [];
    const stats: DiffStats = { added: 0, removed: 0, unchanged: 0 };

    const pushSame = (leftIndex: number, rightIndex: number) => {
        rows.push({ type: 'same', leftLine: leftIndex + 1, rightLine: rightIndex + 1, text: leftLines[leftIndex]! });
        stats.unchanged += 1;
    };
    const pushDel = (leftIndex: number) => {
        rows.push({ type: 'del', leftLine: leftIndex + 1, rightLine: null, text: leftLines[leftIndex]! });
        stats.removed += 1;
    };
    const pushAdd = (rightIndex: number) => {
        rows.push({ type: 'add', leftLine: null, rightLine: rightIndex + 1, text: rightLines[rightIndex]! });
        stats.added += 1;
    };

    for (let i = 0; i < head; i += 1) pushSame(i, i);

    let i = 0;
    let j = 0;
    while (i < midLeft.length && j < midRight.length) {
        if (midLeft[i] === midRight[j]) {
            pushSame(head + i, head + j);
            i += 1;
            j += 1;
        } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
            // Deletions are emitted before additions so a replaced line reads
            // as "old line, then new line".
            pushDel(head + i);
            i += 1;
        } else {
            pushAdd(head + j);
            j += 1;
        }
    }
    while (i < midLeft.length) {
        pushDel(head + i);
        i += 1;
    }
    while (j < midRight.length) {
        pushAdd(head + j);
        j += 1;
    }

    for (let k = 0; k < tail; k += 1) {
        pushSame(leftLines.length - tail + k, rightLines.length - tail + k);
    }

    return { rows, stats, truncated };
}
