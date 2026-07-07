export type AssetKind = "css-class" | "css-id" | "js-function";
export type AssetStatus = "unused" | "dynamic";

export interface UnusedAsset {
    kind: AssetKind;
    name: string;
    file: string;
    line: number;
}

export interface ScanResult {
    cssUnused: UnusedAsset[];
    cssDynamic: UnusedAsset[];
    jsUnused: UnusedAsset[];
    filesScanned: number;
    filesSkipped: number;
}

export interface ScannedFile {
    path: string;
    content: string;
}

export type ReviewStatus = "confirmed-unused" | "false-positive" | "needs-review";

export interface ReviewVerdict {
    verdict: ReviewStatus;
    reason: string;
}
