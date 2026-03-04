import { useState } from "react";
import type { PageSpeedInsightResult, PageSpeedConfiguration, UsePageSpeedInsightHooks, PageSpeedErrorResponse } from "@shared/types/pageSpeedInsight.types";
import { googleApi } from "@/services/googleApi";
import { defaultPageSpeedResult } from "@/lib/pageSpeedUtils";

export const usePageSpeedInsight = (config: PageSpeedConfiguration): UsePageSpeedInsightHooks => {

    const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

    const audit = async (url: string): Promise<PageSpeedInsightResult> => {
        let result = defaultPageSpeedResult(url);
        if (isElectron) {
            result = await window.electronAPI.runAudit(url, config.strategy);
        } else {
            result = await googleApi.runPagespeed(url, config.apiKey, config.strategy);
        }
        return result;
    };

    return {
        audit
    };
};