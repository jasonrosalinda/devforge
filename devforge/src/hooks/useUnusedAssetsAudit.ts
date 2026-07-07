import { useRef, useState } from "react";
import { assetId, findOccurrences, isScannableFile, runUnusedAssetsScan, shouldIgnorePath } from "@/lib/unusedAssetsAnalyzer";
import type { ReviewVerdict, ScanResult, ScannedFile, UnusedAsset } from "@/types/unusedAssets.types";
import { isElectron } from "@/lib/environment";
import {
    clearHistory as clearHistoryStore,
    deleteSnapshot,
    loadHistory,
    saveSnapshot,
    type UnusedAssetsHistorySnapshot,
} from "@/lib/unused-assets-history";

const BATCH_SIZE = 50;
const REVIEW_CHUNK_SIZE = 20;
const SNIPPET_CONTEXT_LINES = 4;

export type ReviewState = "idle" | "reviewing" | "done" | "error" | "cancelled";

export interface CodeSnippetLine {
    number: number;
    text: string;
    isTarget: boolean;
}

function parseGitBranch(headContent: string): string {
    const trimmed = headContent.trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(trimmed);
    if (match) return match[1]!;
    return `${trimmed.slice(0, 7)} (detached)`;
}

// Electron exposes the absolute path on File objects picked via <input type="file">
// (a Chromium/Electron extension, not standard DOM) — used to resolve the folder's
// absolute path when the browser directory picker hides dotfiles like .git/HEAD.
function resolveFolderAbsPath(firstFile: File, relPath: string): string | null {
    const absPath = (firstFile as File & { path?: string }).path;
    if (!absPath) return null;
    const normalized = absPath.replace(/\\/g, "/");
    if (!normalized.endsWith(relPath)) return null;
    const rootFolder = relPath.split("/")[0]!;
    return normalized.slice(0, normalized.length - relPath.length) + rootFolder;
}

export default function useUnusedAssetsAudit() {
    const [isScanning, setIsScanning] = useState(false);
    const [progress, setProgress] = useState({ processed: 0, total: 0 });
    const [result, setResult] = useState<ScanResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [folderName, setFolderName] = useState<string | null>(null);
    const [gitBranch, setGitBranch] = useState<string | null>(null);
    const scannedFilesRef = useRef<ScannedFile[]>([]);

    const [reviewState, setReviewState] = useState<ReviewState>("idle");
    const [reviewStage, setReviewStage] = useState<string>("");
    const [reviewError, setReviewError] = useState<string | null>(null);
    const [verdicts, setVerdicts] = useState<Record<string, ReviewVerdict>>({});
    const cancelRequestedRef = useRef(false);
    const [history, setHistory] = useState<UnusedAssetsHistorySnapshot[]>(() => loadHistory());
    const [isFromHistory, setIsFromHistory] = useState(false);

    const scanFolder = async (fileList: FileList): Promise<void> => {
        setIsScanning(true);
        setError(null);
        setResult(null);
        setVerdicts({});
        setReviewState("idle");
        setReviewError(null);
        setIsFromHistory(false);

        try {
            const allFiles = Array.from(fileList);
            const firstRelPath = allFiles[0]?.webkitRelativePath;
            setFolderName(firstRelPath ? firstRelPath.split("/")[0]! : null);

            const headFile = allFiles.find((file) => /\/\.git\/HEAD$/.test(file.webkitRelativePath || ""));
            if (headFile) {
                try {
                    setGitBranch(parseGitBranch(await headFile.text()));
                } catch {
                    setGitBranch(null);
                }
            } else if (isElectron() && window.electronAPI.unusedAssets && allFiles[0] && firstRelPath) {
                const folderAbsPath = resolveFolderAbsPath(allFiles[0], firstRelPath);
                if (folderAbsPath) {
                    const res = await window.electronAPI.unusedAssets.gitBranch({ folderPath: folderAbsPath });
                    setGitBranch(res.success ? (res.branch ?? null) : null);
                } else {
                    setGitBranch(null);
                }
            } else {
                setGitBranch(null);
            }

            const candidates = allFiles.filter((file) => {
                const relPath = file.webkitRelativePath || file.name;
                return isScannableFile(relPath) && !shouldIgnorePath(relPath);
            });

            setProgress({ processed: 0, total: candidates.length });

            const scanned: ScannedFile[] = [];
            for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
                const batch = candidates.slice(i, i + BATCH_SIZE);
                const contents = await Promise.all(batch.map((file) => file.text()));
                batch.forEach((file, idx) => {
                    scanned.push({ path: file.webkitRelativePath || file.name, content: contents[idx]! });
                });
                setProgress({ processed: scanned.length, total: candidates.length });
            }

            scannedFilesRef.current = scanned;
            const scanResult = runUnusedAssetsScan(scanned);
            setResult({ ...scanResult, filesSkipped: allFiles.length - candidates.length });
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to scan folder");
        } finally {
            setIsScanning(false);
        }
    };

    const reviewWithClaude = async (assets: UnusedAsset[]): Promise<void> => {
        if (!isElectron() || !window.electronAPI.unusedAssets) {
            setReviewState("error");
            setReviewError("Claude review requires the devForge desktop app.");
            return;
        }
        if (assets.length === 0) return;

        cancelRequestedRef.current = false;
        setReviewState("reviewing");
        setReviewError(null);
        setReviewStage("Preparing review…");

        const offProgress = window.electronAPI.unusedAssets.onReviewProgress(({ stage }) => {
            setReviewStage(stage);
        });

        const chunks: UnusedAsset[][] = [];
        for (let i = 0; i < assets.length; i += REVIEW_CHUNK_SIZE) {
            chunks.push(assets.slice(i, i + REVIEW_CHUNK_SIZE));
        }

        const files = scannedFilesRef.current;
        const failedChunks: string[] = [];
        let wasCancelled = false;

        try {
            for (let i = 0; i < chunks.length; i++) {
                if (cancelRequestedRef.current) {
                    wasCancelled = true;
                    break;
                }

                const chunk = chunks[i]!;
                setReviewStage(`Reviewing batch ${i + 1}/${chunks.length} (${chunk.length} items)…`);

                const candidates = chunk.map((asset) => ({
                    id: assetId(asset),
                    kind: asset.kind,
                    name: asset.name,
                    file: asset.file,
                    line: asset.line,
                }));
                const evidence: Record<string, { file: string; line: number; text: string }[]> = {};
                for (const asset of chunk) {
                    evidence[assetId(asset)] = findOccurrences(asset, files);
                }

                try {
                    const res = await window.electronAPI.unusedAssets.review({ candidates, evidence });
                    if (res.cancelled) {
                        wasCancelled = true;
                        break;
                    }
                    if (!res.success || !res.verdicts) {
                        failedChunks.push(`batch ${i + 1}: ${res.error ?? "unknown error"}`);
                        continue;
                    }
                    const next: Record<string, ReviewVerdict> = {};
                    for (const v of res.verdicts) {
                        next[v.id] = { verdict: v.verdict, reason: v.reason };
                    }
                    setVerdicts((prev) => ({ ...prev, ...next }));
                } catch (err) {
                    failedChunks.push(`batch ${i + 1}: ${err instanceof Error ? err.message : "unknown error"}`);
                }
            }

            if (wasCancelled || cancelRequestedRef.current) {
                setReviewState("cancelled");
                setReviewStage("");
            } else if (failedChunks.length > 0) {
                setReviewState("error");
                setReviewError(`${failedChunks.length}/${chunks.length} batch(es) failed — ${failedChunks.join("; ")}`);
            } else {
                setReviewState("done");
            }
        } finally {
            offProgress();
        }
    };

    const cancelReview = (): void => {
        if (!isElectron() || !window.electronAPI.unusedAssets) return;
        cancelRequestedRef.current = true;
        setReviewStage("Cancelling…");
        void window.electronAPI.unusedAssets.cancelReview();
    };

    const getSnippet = (asset: UnusedAsset): CodeSnippetLine[] | null => {
        const file = scannedFilesRef.current.find((f) => f.path === asset.file);
        if (!file) return null;
        const lines = file.content.split(/\r\n|\n/);
        const start = Math.max(0, asset.line - 1 - SNIPPET_CONTEXT_LINES);
        const end = Math.min(lines.length, asset.line + SNIPPET_CONTEXT_LINES);
        const out: CodeSnippetLine[] = [];
        for (let i = start; i < end; i++) {
            out.push({ number: i + 1, text: lines[i] ?? "", isTarget: i + 1 === asset.line });
        }
        return out;
    };

    const saveToHistory = (): void => {
        if (!result) return;
        const snapshot: UnusedAssetsHistorySnapshot = {
            id: String(Date.now()),
            savedAt: new Date().toISOString(),
            folderName,
            gitBranch,
            result,
            verdicts,
        };
        setHistory(saveSnapshot(snapshot));
    };

    const restoreFromHistory = (snapshot: UnusedAssetsHistorySnapshot): void => {
        setFolderName(snapshot.folderName);
        setGitBranch(snapshot.gitBranch);
        setResult(snapshot.result);
        setVerdicts(snapshot.verdicts);
        setError(null);
        setReviewState("idle");
        setReviewError(null);
        setIsFromHistory(true);
        // Raw file content isn't persisted (only the computed findings) — code
        // snippets and further Claude review need a fresh scan of the folder.
        scannedFilesRef.current = [];
    };

    const deleteHistoryEntry = (id: string): void => setHistory(deleteSnapshot(id));
    const clearAllHistory = (): void => { clearHistoryStore(); setHistory([]); };

    const reset = (): void => {
        setResult(null);
        setError(null);
        setProgress({ processed: 0, total: 0 });
        setVerdicts({});
        setReviewState("idle");
        setReviewError(null);
        setFolderName(null);
        setGitBranch(null);
        setIsFromHistory(false);
        cancelRequestedRef.current = false;
        scannedFilesRef.current = [];
    };

    return {
        isScanning,
        progress,
        result,
        error,
        folderName,
        gitBranch,
        scanFolder,
        reset,
        reviewState,
        reviewStage,
        reviewError,
        verdicts,
        reviewWithClaude,
        cancelReview,
        getSnippet,
        history,
        saveToHistory,
        restoreFromHistory,
        deleteHistoryEntry,
        clearAllHistory,
        isFromHistory,
    };
}
