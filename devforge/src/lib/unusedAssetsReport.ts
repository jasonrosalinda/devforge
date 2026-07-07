import { assetId, displayName } from "@/lib/unusedAssetsAnalyzer";
import type { ReviewVerdict, ScanResult, UnusedAsset } from "@/types/unusedAssets.types";

function noteFor(asset: UnusedAsset, verdicts: Record<string, ReviewVerdict>): string {
    const verdict = verdicts[assetId(asset)];
    if (!verdict || verdict.verdict === "confirmed-unused") return "—";
    return verdict.reason;
}

function statusFor(asset: UnusedAsset, verdicts: Record<string, ReviewVerdict>, dynamicIds: Set<string>): string {
    const id = assetId(asset);
    const verdict = verdicts[id];
    if (verdict) {
        return verdict.verdict === "confirmed-unused" ? "Confirmed unused"
            : verdict.verdict === "false-positive" ? "False positive"
            : "Needs review";
    }
    return dynamicIds.has(id) ? "Need review" : "—";
}

function renderSection(
    title: string,
    assets: UnusedAsset[],
    verdicts: Record<string, ReviewVerdict>,
    dynamicIds: Set<string>
): string {
    if (assets.length === 0) {
        return `## ${title} (0)\n\nNone found.\n`;
    }
    const rows = assets
        .map((a) => `| \`${displayName(a)}\` | ${a.file}:${a.line} | ${statusFor(a, verdicts, dynamicIds)} | ${noteFor(a, verdicts)} |`)
        .join("\n");
    return `## ${title} (${assets.length})\n\n| Name | Location | Status | Note |\n|---|---|---|---|\n${rows}\n`;
}

export function buildUnusedAssetsReport(opts: {
    folderName: string | null;
    gitBranch: string | null;
    result: ScanResult;
    verdicts: Record<string, ReviewVerdict>;
    generatedAt: Date;
}): string {
    const { folderName, gitBranch, result, verdicts, generatedAt } = opts;
    const cssAll = [...result.cssUnused, ...result.cssDynamic];
    const dynamicIds = new Set(result.cssDynamic.map(assetId));

    const header = [
        "# Unused Assets Report",
        "",
        `- Folder: \`${folderName ?? "unknown"}\``,
        ...(gitBranch ? [`- Branch: \`${gitBranch}\``] : []),
        `- Generated: ${generatedAt.toLocaleString()}`,
        `- Files scanned: ${result.filesScanned} (skipped: ${result.filesSkipped})`,
        `- Unused CSS: ${cssAll.length} (${result.cssDynamic.length} need review)`,
        `- Unused JS: ${result.jsUnused.length}`,
        "",
    ].join("\n");

    return [
        header,
        renderSection("Unused CSS", cssAll, verdicts, dynamicIds),
        renderSection("Unused JS", result.jsUnused, verdicts, new Set()),
    ].join("\n");
}
