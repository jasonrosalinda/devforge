import { useState } from "react";
import type { PageSpeedInsightResult, PageSpeedConfiguration, UsePageSpeedInsightHooks, PageSpeedErrorResponse } from "@shared/types/pageSpeedInsight.types";
import { googleApi } from "@/services/googleApi";
import { defaultPageSpeedResult } from "@/lib/pageSpeedUtils";
import { isElectron } from "@/lib/environment";

export const usePageSpeedInsight = (config: PageSpeedConfiguration): UsePageSpeedInsightHooks => {

    const audit = async (url: string): Promise<PageSpeedInsightResult> => {
        let result = defaultPageSpeedResult(url);
        if (config.browserMode) {
            result = await window.electronAPI.runAudit(url, config.strategy, config.visitMode, config.runMode);
        } else {
            result = await googleApi.runPagespeed(url, config.apiKey, config.strategy, config.runMode);
        }
        return result;
    };

    const clearCache = async () => {
        if (isElectron()) {
            return await window.electronAPI.clearLighthouseCache();
        }
        return { success: false };
    };

    return {
        audit,
        clearCache
    };
};