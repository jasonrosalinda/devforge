import { PageSpeedResults } from "@/components/pagespeed/pagespeed-result";
import { useState } from "react";
import PageSpeedConfig from "@/components/pagespeed/pagespeed-config";
import { type PageSpeedConfiguration } from "@shared/types/pageSpeedInsight.types";
import { defaultPageSpeedConfiguration } from "@/lib/pageSpeedUtils";

export default function PageSpeedResultPage() {
    const [desktopConfig, setDesktopConfig] = useState(defaultPageSpeedConfiguration('desktop'));
    const [mobileConfig, setMobileConfig] = useState(defaultPageSpeedConfiguration('mobile'));
    const onConfigChanged = (config: PageSpeedConfiguration) => {
        setDesktopConfig({ ...config, strategy: 'desktop' });
        setMobileConfig({ ...config, strategy: 'mobile' });
    };

    return (
        <>
            <PageSpeedConfig configHasChanged={onConfigChanged} />
            <PageSpeedResults config={desktopConfig} />
            <PageSpeedResults config={mobileConfig} />
        </>
    );
}
