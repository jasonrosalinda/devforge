import { PageSpeedResults, type PageSpeedResultsHandle } from "@/components/pagespeed/pagespeed-result";
import { useRef, useState } from "react";
import PageSpeedConfig from "@/components/pagespeed/pagespeed-config";
import { type PageSpeedConfiguration } from "@shared/types/pageSpeedInsight.types";
import { defaultPageSpeedConfiguration } from "@/lib/pageSpeedUtils";
import { useSettings } from "@/context/settings-context";
import { Button } from "@/components/ui";
import { isNullOrEmpty } from "@shared/utils/stringHelper";
import { Loader2, Sparkles } from "lucide-react";
import { SiPagespeedinsights } from "react-icons/si";
import { PageHeader } from "@/components/layout/page-header";

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
                <PageSpeedConfig configHasChanged={onConfigChanged} isAuditing={isAuditing} />
            </div>
            <PageSpeedResults ref={desktopRef} config={desktopConfig} onAuditingChange={setDesktopAuditing} />
            <PageSpeedResults ref={mobileRef} config={mobileConfig} onAuditingChange={setMobileAuditing} />
        </>
    );
}
