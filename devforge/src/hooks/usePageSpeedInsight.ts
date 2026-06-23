import { useState } from "react";
import type { PageSpeedInsightResult, PageSpeedConfiguration, UsePageSpeedInsightHooks, PageSpeedErrorResponse } from "@shared/types/pageSpeedInsight.types";
import { googleApi } from "@/services/googleApi";
import { defaultPageSpeedResult } from "@/lib/pageSpeedUtils";
import { isElectron } from "@/lib/environment";

export const usePageSpeedInsight = (config: PageSpeedConfiguration): UsePageSpeedInsightHooks => {

    const audit = async (url: string, signal?: AbortSignal, runMode: PageSpeedConfiguration['runMode'] = config.runMode): Promise<PageSpeedInsightResult> => {
        if (config.browserMode) {
            const ipcPromise = window.electronAPI.runAudit(url, config.strategy, config.visitMode, runMode);
            if (signal) {
                return await Promise.race([
                    ipcPromise,
                    new Promise<never>((_, reject) => {
                        if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
                        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                    }),
                ]);
            }
            return await ipcPromise;
        }
        return await googleApi.runPagespeed(url, config.apiKey, config.strategy, runMode, signal);
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