import { useCallback, useState } from 'react';
import { marked } from 'marked';
import { toast } from 'sonner';
import type { IncidentPayload, ReportKind } from '@shared/types/electron';
import type { RcaStatus } from '@/components/azure/rcaDialog';
import {
    buildRcaPrintHtml, buildRcaWordHtml, formatSgt, formatSgtRange, splitQuickSummary,
    buildQuickSummaryTeamsHtml, buildQuickSummaryTeamsText, parseRcaFields,
} from '@/components/azure/rcaHtml';
import { acceptsRcaEvent, newRunId, rcaOutputOf } from '@/lib/rca-report';

export type RcaFormat = 'engineering' | 'business';

/** Facts the caller already measured or has configured, so the model reproduces them. */
export interface RcaGiven {
    incidentName?: string;
    incidentPeriod?: string;
    servicesAffected?: string;
    reportTitle?: string;
}

/**
 * One Claude RCA run plus its exports — the state App Health Check's card has always
 * kept, lifted out so App Investigation produces the identical report.
 *
 * `getPayload` supplies the incident window and Azure identifiers; `extra.reportMarkdown`
 * hands over a telemetry report already collected, so the RCA does not pull Azure again.
 */
export function useRcaReport({ appKey, getPayload, fileSuffix }: { appKey: string; getPayload: () => IncidentPayload; fileSuffix?: string | undefined }) {
    const [status, setStatus] = useState<RcaStatus>('idle');
    const [text, setText] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [stages, setStages] = useState<string[]>([]);
    const [draft, setDraft] = useState('');
    const output = rcaOutputOf(draft, text);
    // The RCA's file name: the incident number in the report, then the app's suffix.
    const naming = (markdown: string) => ({ incidentNumber: parseRcaFields(markdown).incidentNumber, fileSuffix });

    const reset = useCallback(() => {
        setStatus('idle');
        setText('');
        setError(null);
        setStages([]);
    }, []);

    const run = useCallback(async (
        investigationNotes: string,
        format: RcaFormat = 'engineering',
        given: RcaGiven = {},
        extra: { reportMarkdown?: string } = {},
    ) => {
        const runId = newRunId();
        setStatus('running');
        setText('');
        setError(null);
        setStages([]);
        const offChunk = window.electronAPI.incidentReport.onRcaChunk((data) => {
            if (acceptsRcaEvent(data, appKey, runId)) setText(prev => prev + data.chunk);
        });
        const offProgress = window.electronAPI.incidentReport.onRcaProgress((data) => {
            if (!acceptsRcaEvent(data, appKey, runId)) return;
            setStages(prev => [...prev, data.stage]);
            // Model fallback restarts the stream — drop the aborted partial so the two
            // attempts don't render as one stitched-together analysis.
            if (data.reset) setText('');
        });
        try {
            const result = await window.electronAPI.incidentReport.rca({
                ...getPayload(), investigationNotes, format, ...given, ...extra, runId,
            });
            if (result.success && result.rca) {
                setText(result.rca);
                setStatus('done');
            } else {
                setError(result.error ?? 'Unknown error');
                setStatus('error');
            }
        } catch (e: any) {
            setError(e?.message ?? 'Unknown error');
            setStatus('error');
        } finally {
            offChunk();
            offProgress();
        }
    }, [appKey, getPayload]);

    const exportMd = useCallback(async (kind: ReportKind = 'rca', markdown: string = output) => {
        try {
            const { startMs, endMs } = getPayload();
            const result = await window.electronAPI.incidentReport.saveRca({ appName: appKey, startMs, endMs, markdown, kind, ...naming(markdown) });
            if (!result.success) throw new Error(result.error ?? 'Save failed');
            await navigator.clipboard.writeText(markdown);
            toast.success(kind === 'rca' ? 'RCA saved & markdown copied' : 'Report saved & markdown copied');
        } catch (e: any) {
            toast.error('Export failed', { description: e?.message });
        }
    }, [appKey, getPayload, output]);

    const exportPdf = useCallback(async (kind: ReportKind = 'rca', markdown: string = output) => {
        try {
            const { startMs, endMs } = getPayload();
            // HTML is built here rather than in main: `marked` and the print stylesheet
            // both live on the renderer side.
            const html = buildRcaPrintHtml(markdown, {
                appName: appKey,
                window: formatSgtRange(startMs, endMs),
                generated: formatSgt(Date.now()),
            });
            const result = await window.electronAPI.incidentReport.exportRcaPdf({ appName: appKey, startMs, endMs, html, kind, ...naming(markdown) });
            if (!result.success) throw new Error(result.error ?? 'PDF export failed');
            toast.success(kind === 'rca' ? 'RCA PDF saved' : 'Report PDF saved');
        } catch (e: any) {
            toast.error('PDF export failed', { description: e?.message });
        }
    }, [appKey, getPayload, output]);

    const exportWord = useCallback(async (kind: ReportKind = 'rca', markdown: string = output) => {
        try {
            const { startMs, endMs } = getPayload();
            const html = buildRcaWordHtml(markdown, {
                appName: appKey,
                window: formatSgtRange(startMs, endMs),
                generated: formatSgt(Date.now()),
            });
            const result = await window.electronAPI.incidentReport.exportRcaDoc({ appName: appKey, startMs, endMs, html, kind, ...naming(markdown) });
            if (!result.success) throw new Error(result.error ?? 'Word export failed');
            toast.success(kind === 'rca' ? 'RCA Word document saved' : 'Report Word document saved');
        } catch (e: any) {
            toast.error('Word export failed', { description: e?.message });
        }
    }, [appKey, getPayload, output]);

    // Just the plain-English summary, formatted for a Teams chat — the part that
    // gets shared with non-engineers, without the full report attached.
    const copySummary = useCallback(async () => {
        try {
            const { summary } = splitQuickSummary(output);
            if (!summary) throw new Error('This report has no Quick Summary section.');
            const { startMs, endMs } = getPayload();
            const meta = { appName: appKey, window: formatSgtRange(startMs, endMs) };
            await navigator.clipboard.write([
                new ClipboardItem({
                    'text/html': new Blob([buildQuickSummaryTeamsHtml(summary, meta)], { type: 'text/html' }),
                    'text/plain': new Blob([buildQuickSummaryTeamsText(summary, meta)], { type: 'text/plain' }),
                }),
            ]);
            toast.success('Quick Summary copied for Teams');
        } catch (e: any) {
            toast.error('Copy failed', { description: e?.message });
        }
    }, [appKey, getPayload, output]);

    const copyTeams = useCallback(async (markdown: string = output) => {
        try {
            const htmlBody = marked.parse(markdown, { async: false }) as string;
            await navigator.clipboard.write([
                new ClipboardItem({
                    'text/html': new Blob([htmlBody], { type: 'text/html' }),
                    // A pasted image as base64 text is useless, so the plain copy leaves it out.
                    'text/plain': new Blob([markdown.replace(/!\[[^\]]*\]\(data:[^)]*\)\n*/g, '')], { type: 'text/plain' }),
                }),
            ]);
            toast.success('Copied for Teams');
        } catch (e: any) {
            toast.error('Copy failed', { description: e?.message });
        }
    }, [output]);

    return { status, text, error, stages, draft, setDraft, output, reset, run, exportMd, exportPdf, exportWord, copySummary, copyTeams };
}
