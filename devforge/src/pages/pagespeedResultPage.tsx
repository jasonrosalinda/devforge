import { PageSpeedResults, type PageSpeedResultsHandle } from "@/components/pagespeed/pagespeed-result";
import { useRef, useState } from "react";
import PageSpeedConfig from "@/components/pagespeed/pagespeed-config";
import PageSpeedHistoryDropdown from "@/components/pagespeed/pagespeed-history-dropdown";
import { type PageSpeedConfiguration } from "@shared/types/pageSpeedInsight.types";
import { defaultPageSpeedConfiguration } from "@/lib/pageSpeedUtils";
import {
    loadHistory,
    saveSnapshot,
    deleteSnapshot,
    clearHistory,
    type PageSpeedHistorySnapshot,
    type StrategySnapshot,
    type SerializedAuditSlot,
    type SerializedTimes,
} from "@/lib/pagespeed-history";
import { useSettings } from "@/context/settings-context";
import { Button, Toast } from "@/components/ui";
import { isNullOrEmpty } from "@shared/utils/stringHelper";
import { Loader2, Save, Sparkles } from "lucide-react";
import { SiPagespeedinsights } from "react-icons/si";
import { PageHeader } from "@/components/layout/page-header";

type ResultsBundle = ReturnType<PageSpeedResultsHandle["getResults"]>;

const serializeTimes = (t: { start: Date | null; end: Date | null }): SerializedTimes => ({
    start: t.start ? t.start.toISOString() : null,
    end: t.end ? t.end.toISOString() : null,
});

const toStrategySnapshot = (r: ResultsBundle): StrategySnapshot => ({
    // Drop `null` (loading) and coerce `undefined` to null for stable JSON round-tripping.
    results1: r.results1.map(s => (s == null ? null : s)) as SerializedAuditSlot[],
    results2: r.results2.map(s => (s == null ? null : s)) as SerializedAuditSlot[],
    times1: serializeTimes(r.times1),
    times2: serializeTimes(r.times2),
    auditStart: r.auditStart ? r.auditStart.toISOString() : null,
    auditEnd: r.auditEnd ? r.auditEnd.toISOString() : null,
    analyses: r.analyses,
});

export default function PageSpeedResultPage() {
    const { settings } = useSettings();
    const apiKey = settings.apiKeys.pagespeedApiKey;
    const [desktopConfig, setDesktopConfig] = useState(() => ({ ...defaultPageSpeedConfiguration('desktop'), apiKey }));
    const [mobileConfig, setMobileConfig] = useState(() => ({ ...defaultPageSpeedConfiguration('mobile'), apiKey }));
    const onConfigChanged = (config: PageSpeedConfiguration) => {
        setDesktopConfig({ ...config, strategy: 'desktop', apiKey });
        setMobileConfig({ ...config, strategy: 'mobile', apiKey });
    };

    const [desktopAuditing, setDesktopAuditing] = useState(false);
    const [mobileAuditing, setMobileAuditing] = useState(false);
    const isAuditing = desktopAuditing || mobileAuditing;

    const [exportingInsights, setExportingInsights] = useState(false);

    const toast = Toast();
    const [history, setHistory] = useState<PageSpeedHistorySnapshot[]>(() => loadHistory());
    const [restoredConfig, setRestoredConfig] = useState<PageSpeedConfiguration | undefined>(undefined);
    const [restoreToken, setRestoreToken] = useState(0);

    const desktopRef = useRef<PageSpeedResultsHandle>(null);
    const mobileRef = useRef<PageSpeedResultsHandle>(null);

    const analyzeAll = () => {
        desktopRef.current?.startAudit();
        mobileRef.current?.startAudit();
    };

    const cancelAll = () => {
        desktopRef.current?.cancelAudit();
        mobileRef.current?.cancelAudit();
    };

    const canAnalyze = desktopConfig.urls.length > 0 &&
        (!desktopConfig.browserMode ? !isNullOrEmpty(desktopConfig.apiKey) : true);

    const hasResults =
        (desktopRef.current?.getResults().results1.some(r => r && r !== null) ?? false) ||
        (mobileRef.current?.getResults().results1.some(r => r && r !== null) ?? false);

    const saveToHistory = () => {
        const desktop = desktopRef.current?.getResults();
        const mobile = mobileRef.current?.getResults();
        if (!desktop || !mobile) return;
        const id = String(Date.now());
        const snapshot: PageSpeedHistorySnapshot = {
            id,
            savedAt: new Date().toISOString(),
            // Strip apiKey — never persist secrets; re-injected from settings on restore.
            config: { ...desktopConfig, apiKey: '' },
            desktop: toStrategySnapshot(desktop),
            mobile: toStrategySnapshot(mobile),
        };
        setHistory(saveSnapshot(snapshot));
        toast.success('Analysis saved to history');
    };

    const restoreFromHistory = (snapshot: PageSpeedHistorySnapshot) => {
        setDesktopConfig({ ...snapshot.config, strategy: 'desktop', apiKey });
        setMobileConfig({ ...snapshot.config, strategy: 'mobile', apiKey });
        setRestoredConfig({ ...snapshot.config, apiKey });
        setRestoreToken(t => t + 1);
        desktopRef.current?.restoreSnapshot(snapshot.desktop);
        mobileRef.current?.restoreSnapshot(snapshot.mobile);
        toast.info('Restored analysis from ' + new Date(snapshot.savedAt).toLocaleString());
    };

    const onDeleteHistory = (id: string) => setHistory(deleteSnapshot(id));
    const onClearHistory = () => { clearHistory(); setHistory([]); };

    const exportInsights = async () => {
        setExportingInsights(true);
        try {
            const desktop = desktopRef.current?.getResults();
            const mobile = mobileRef.current?.getResults();
            await window.electronAPI.pagespeedInsight.generate({ desktop, mobile });
        } finally {
            setExportingInsights(false);
        }
    };

    return (
        <>
            <PageHeader
                icon={SiPagespeedinsights}
                title="PageSpeed"
                subtitle="Run Lighthouse / PageSpeed Insights audits across desktop and mobile — single run, branch compare, or averaged."
            />
            <div className="flex items-center justify-end gap-2">
                {isAuditing && (
                    <Button variant="outline" onClick={cancelAll}>Cancel</Button>
                )}
                <PageSpeedHistoryDropdown
                    entries={history}
                    onSelect={restoreFromHistory}
                    onDelete={onDeleteHistory}
                    onClear={onClearHistory}
                    disabled={isAuditing}
                />
                <Button variant="outline" onClick={saveToHistory} disabled={isAuditing || !hasResults}>
                    <Save className="mr-1 h-4 w-4" />Save to history
                </Button>
                <PageSpeedConfig configHasChanged={onConfigChanged} isAuditing={isAuditing} value={restoredConfig} restoreToken={restoreToken} />
            </div>
            <PageSpeedResults ref={desktopRef} config={desktopConfig} onAuditingChange={setDesktopAuditing} />
            <PageSpeedResults ref={mobileRef} config={mobileConfig} onAuditingChange={setMobileAuditing} />
        </>
    );
}
