import { useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Code2, FileText, FolderSearch, Loader2, Save, Sparkles } from "lucide-react";
import useUnusedAssetsAudit, { type CodeSnippetLine } from "@/hooks/useUnusedAssetsAudit";
import UnusedAssetsHistoryDropdown from "@/components/unusedassets/unused-assets-history-dropdown";
import { assetId, displayName } from "@/lib/unusedAssetsAnalyzer";
import { buildUnusedAssetsReport } from "@/lib/unusedAssetsReport";
import type { ReviewVerdict, UnusedAsset } from "@/types/unusedAssets.types";
import { isElectron } from "@/lib/environment";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable } from "@/components/ui/data-table";
import { DataTableSearchBox } from "@/components/ui/data-table-search-box";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Toast } from "@/components/ui/toast";

const VERDICT_LABEL: Record<ReviewVerdict["verdict"], string> = {
    "confirmed-unused": "Confirmed unused",
    "false-positive": "False positive",
    "needs-review": "Needs review",
};

const VERDICT_COLOR: Record<ReviewVerdict["verdict"], string> = {
    "confirmed-unused": "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    "false-positive": "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
    "needs-review": "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
};

type StatusFilter = "all" | ReviewVerdict["verdict"];

function StatusFilterBadge({
    active,
    onClick,
    className,
    children,
}: {
    active: boolean;
    onClick: () => void;
    className: string;
    children: React.ReactNode;
}) {
    return (
        <Badge
            variant="outline"
            onClick={onClick}
            className={cn(
                "font-normal text-[10px] px-1.5 py-0 leading-4 cursor-pointer select-none",
                className,
                active ? "ring-1 ring-offset-0 ring-current" : "opacity-70 hover:opacity-100"
            )}
        >
            {children}
        </Badge>
    );
}

function CopyableName({ name, label }: { name: string; label: string }) {
    const toast = Toast();

    const onCopy = () => {
        void navigator.clipboard.writeText(name);
        toast.success(`Copied "${name}"`);
    };

    return (
        <span
            onClick={onCopy}
            title="Click to copy"
            className="cursor-pointer font-mono text-sm hover:text-foreground text-foreground/90"
        >
            {label}
        </span>
    );
}

function ViewCodeButton({ asset, getSnippet }: { asset: UnusedAsset; getSnippet: (asset: UnusedAsset) => CodeSnippetLine[] | null }) {
    const [open, setOpen] = useState(false);
    const snippet = open ? getSnippet(asset) : null;

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <button type="button" title="View code" className="text-muted-foreground hover:text-foreground shrink-0">
                    <Code2 className="w-3.5 h-3.5" />
                </button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle className="font-mono text-sm font-normal">
                        {asset.file} — {asset.line}
                    </DialogTitle>
                </DialogHeader>
                {snippet ? (
                    <pre className="text-xs overflow-x-auto rounded-md border bg-muted/30 p-3">
                        {snippet.map((line) => (
                            <div key={line.number} className={cn("flex gap-3 px-1", line.isTarget && "bg-amber-500/15")}>
                                <span className="text-muted-foreground select-none w-8 shrink-0 text-right">{line.number}</span>
                                <span className="whitespace-pre">{line.text}</span>
                            </div>
                        ))}
                    </pre>
                ) : (
                    <p className="text-sm text-muted-foreground">Snippet unavailable — file content was not retained from the scan.</p>
                )}
            </DialogContent>
        </Dialog>
    );
}

function buildColumns(
    verdicts: Record<string, ReviewVerdict>,
    getSnippet: (asset: UnusedAsset) => CodeSnippetLine[] | null
): ColumnDef<UnusedAsset>[] {
    return [
        {
            accessorKey: "name",
            header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
            cell: ({ row }) => (
                <div className="flex items-center gap-2">
                    <CopyableName name={row.original.name} label={displayName(row.original)} />
                    <ViewCodeButton asset={row.original} getSnippet={getSnippet} />
                </div>
            ),
        },
        {
            id: "status",
            accessorFn: (row) => {
                const verdict = verdicts[assetId(row)];
                return verdict ? VERDICT_LABEL[verdict.verdict] : "";
            },
            header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
            cell: ({ row }) => {
                const verdict = verdicts[assetId(row.original)];
                if (!verdict) {
                    return <span className="text-xs text-muted-foreground">—</span>;
                }
                return (
                    <Badge variant="outline" title={verdict.reason} className={cn("font-normal text-[10px] px-1.5 py-0 leading-4", VERDICT_COLOR[verdict.verdict])}>
                        {VERDICT_LABEL[verdict.verdict]}
                    </Badge>
                );
            },
        },
        {
            accessorKey: "file",
            header: ({ column }) => <DataTableColumnHeader column={column} title="File" />,
            cell: ({ row }) => (
                <span className="text-sm text-muted-foreground">
                    {row.original.file} — {row.original.line}
                </span>
            ),
        },
        {
            id: "note",
            header: ({ column }) => <DataTableColumnHeader column={column} title="Note" />,
            cell: ({ row }) => {
                const verdict = verdicts[assetId(row.original)];
                if (!verdict || verdict.verdict === "confirmed-unused") {
                    return <span className="text-xs text-muted-foreground">—</span>;
                }
                return <span className="text-sm text-muted-foreground">{verdict.reason}</span>;
            },
        },
    ];
}

function ResultTable({
    data,
    placeholder,
    verdicts,
    getSnippet,
    onReview,
    onCancel,
    isReviewing,
    reviewStage,
    reviewDisabled,
    reviewDisabledReason,
}: {
    data: UnusedAsset[];
    placeholder: string;
    verdicts: Record<string, ReviewVerdict>;
    getSnippet: (asset: UnusedAsset) => CodeSnippetLine[] | null;
    onReview: () => void;
    onCancel: () => void;
    isReviewing: boolean;
    reviewStage: string;
    reviewDisabled: boolean;
    reviewDisabledReason: string;
}) {
    const columns = buildColumns(verdicts, getSnippet);
    const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

    const confirmedCount = data.reduce((n, a) => n + (verdicts[assetId(a)]?.verdict === "confirmed-unused" ? 1 : 0), 0);
    const falsePositiveCount = data.reduce((n, a) => n + (verdicts[assetId(a)]?.verdict === "false-positive" ? 1 : 0), 0);
    const needsReviewVerdictCount = data.reduce((n, a) => n + (verdicts[assetId(a)]?.verdict === "needs-review" ? 1 : 0), 0);

    const filteredData = data.filter((a) => {
        if (statusFilter === "all") return true;
        return verdicts[assetId(a)]?.verdict === statusFilter;
    });

    return (
        <div className="h-full border rounded-md p-2">
            <DataTable
                header={(table) => (
                    <div className="flex w-full items-center justify-between p-2 gap-2">
                        <div className="flex items-center gap-2">
                            <StatusFilterBadge
                                active={statusFilter === "all"}
                                onClick={() => setStatusFilter("all")}
                                className="bg-muted text-muted-foreground border-border"
                            >
                                {data.length} item(s)
                            </StatusFilterBadge>
                            {confirmedCount > 0 && (
                                <StatusFilterBadge
                                    active={statusFilter === "confirmed-unused"}
                                    onClick={() => setStatusFilter((s) => (s === "confirmed-unused" ? "all" : "confirmed-unused"))}
                                    className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                                >
                                    {confirmedCount} confirmed unused
                                </StatusFilterBadge>
                            )}
                            {falsePositiveCount > 0 && (
                                <StatusFilterBadge
                                    active={statusFilter === "false-positive"}
                                    onClick={() => setStatusFilter((s) => (s === "false-positive" ? "all" : "false-positive"))}
                                    className="bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30"
                                >
                                    {falsePositiveCount} false positive
                                </StatusFilterBadge>
                            )}
                            {needsReviewVerdictCount > 0 && (
                                <StatusFilterBadge
                                    active={statusFilter === "needs-review"}
                                    onClick={() => setStatusFilter((s) => (s === "needs-review" ? "all" : "needs-review"))}
                                    className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
                                >
                                    {needsReviewVerdictCount} needs review
                                </StatusFilterBadge>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                            {data.length > 0 && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={onReview}
                                    disabled={reviewDisabled}
                                    title={reviewDisabledReason}
                                >
                                    {isReviewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                                    {isReviewing ? (reviewStage || "Reviewing…") : "Review with Claude"}
                                </Button>
                            )}
                            {isReviewing && (
                                <Button variant="ghost" size="sm" onClick={onCancel} className="text-destructive hover:text-destructive">
                                    Cancel
                                </Button>
                            )}
                            <DataTableSearchBox table={table} placeholder={placeholder} />
                        </div>
                    </div>
                )}
                columns={columns}
                data={filteredData}
            />
        </div>
    );
}

export default function UnusedAssetsScan() {
    const {
        isScanning,
        progress,
        result,
        error,
        folderName,
        gitBranch,
        scanFolder,
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
    } = useUnusedAssetsAudit();
    const inputRef = useRef<HTMLInputElement>(null);
    const toast = Toast();

    const handleSaveHistory = () => {
        saveToHistory();
        toast.success("Scan saved to history");
    };

    const handleRestoreHistory = (snapshot: Parameters<typeof restoreFromHistory>[0]) => {
        restoreFromHistory(snapshot);
        toast.info(`Restored scan from ${new Date(snapshot.savedAt).toLocaleString()}`);
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (files && files.length > 0) void scanFolder(files);
        e.target.value = "";
    };

    const reviewSorted = (assets: UnusedAsset[]) => {
        const sorted = [...assets].sort((a, b) => a.name.localeCompare(b.name));
        void reviewWithClaude(sorted);
    };

    const handleReport = () => {
        if (!result) return;
        const markdown = buildUnusedAssetsReport({ folderName, gitBranch, result, verdicts, generatedAt: new Date() });
        const blob = new Blob([markdown], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `unused-assets-report-${folderName ?? "project"}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const isReviewing = reviewState === "reviewing";
    const reviewDisabled = isScanning || isReviewing || !isElectron() || isFromHistory;
    const reviewDisabledReason = isFromHistory
        ? "Loaded from history — rescan the folder to review with Claude"
        : !isElectron()
            ? "Available in the devForge desktop app only"
            : "Ask Claude to verify each flagged item before you delete anything";

    const allFlagged = result ? [...result.cssUnused, ...result.cssDynamic, ...result.jsUnused] : [];
    const allReviewed = allFlagged.length > 0 && allFlagged.every((a) => verdicts[assetId(a)]);

    return (
        <div className="flex flex-col gap-4 flex-1 min-h-0">
            <Card>
                <CardContent className="flex items-center justify-between gap-4 py-4">
                    <div className="flex items-center gap-3">
                        <FolderSearch className="w-5 h-5 text-muted-foreground" />
                        <div>
                            <p className="text-sm font-medium">
                                {folderName ? (
                                    <>
                                        Scanning <span className="font-mono">{folderName}</span>
                                        {gitBranch && <span className="text-muted-foreground font-normal"> ({gitBranch})</span>}
                                    </>
                                ) : (
                                    "Select a project folder to scan"
                                )}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                Detects unused CSS classes/ids and unused JS functions. node_modules, dist, build, and vendor files are skipped automatically.
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <UnusedAssetsHistoryDropdown
                            entries={history}
                            onSelect={handleRestoreHistory}
                            onDelete={deleteHistoryEntry}
                            onClear={clearAllHistory}
                            disabled={isScanning}
                        />
                        {result && (
                            <Button
                                variant="outline"
                                onClick={handleSaveHistory}
                                disabled={!allReviewed}
                                title={allReviewed ? "Save this scan so you can reload it later" : "Review all flagged items with Claude before saving"}
                            >
                                <Save className="w-4 h-4" />
                                Save
                            </Button>
                        )}
                        {result && (
                            <Button variant="outline" onClick={handleReport} title="Download a Markdown report of the findings">
                                <FileText className="w-4 h-4" />
                                Report
                            </Button>
                        )}
                        <Button onClick={() => inputRef.current?.click()} disabled={isScanning}>
                            {isScanning ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                            {isScanning ? `Scanning ${progress.processed}/${progress.total}` : "Select Folder"}
                        </Button>
                    </div>
                    <input
                        ref={inputRef}
                        type="file"
                        // @ts-expect-error non-standard attributes for directory selection
                        webkitdirectory=""
                        directory=""
                        multiple
                        className="hidden"
                        onChange={handleChange}
                    />
                </CardContent>
            </Card>

            {error && (
                <Card className="border-destructive/50">
                    <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
                </Card>
            )}

            {reviewError && (
                <Card className="border-destructive/50">
                    <CardContent className="py-4 text-sm text-destructive">{reviewError}</CardContent>
                </Card>
            )}

            {result && (() => {
                const cssAll = [...result.cssUnused, ...result.cssDynamic];
                return (
                    <Tabs defaultValue="css-unused" className="flex flex-col flex-1 min-h-0">
                        <TabsList className="shrink-0 self-start">
                            <TabsTrigger value="css-unused">CSS ({cssAll.length})</TabsTrigger>
                            <TabsTrigger value="js-unused">JS ({result.jsUnused.length})</TabsTrigger>
                        </TabsList>
                        <TabsContent value="css-unused" className="flex-1 min-h-0">
                            <ResultTable
                                data={cssAll}
                                placeholder="Search unused CSS"
                                verdicts={verdicts}
                                getSnippet={getSnippet}
                                onReview={() => reviewSorted(cssAll)}
                                onCancel={cancelReview}
                                isReviewing={isReviewing}
                                reviewStage={reviewStage}
                                reviewDisabled={reviewDisabled}
                                reviewDisabledReason={reviewDisabledReason}
                            />
                        </TabsContent>
                        <TabsContent value="js-unused" className="flex-1 min-h-0">
                            <ResultTable
                                data={result.jsUnused}
                                placeholder="Search unused JS"
                                verdicts={verdicts}
                                getSnippet={getSnippet}
                                onReview={() => reviewSorted(result.jsUnused)}
                                onCancel={cancelReview}
                                isReviewing={isReviewing}
                                reviewStage={reviewStage}
                                reviewDisabled={reviewDisabled}
                                reviewDisabledReason={reviewDisabledReason}
                            />
                        </TabsContent>
                    </Tabs>
                );
            })()}
        </div>
    );
}
