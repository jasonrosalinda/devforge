import type { PageSpeedInsightResult, PageSpeedConfiguration, UsePageSpeedInsightHooks } from "@shared/types/pageSpeedInsight.types";
import { googleApi } from "@/services/googleApi";

export const usePageSpeedInsight = (config: PageSpeedConfiguration): UsePageSpeedInsightHooks => {

    const audit = async (url: string, signal?: AbortSignal, runs: number = config.runs): Promise<PageSpeedInsightResult> => {
        return await googleApi.runPagespeed(url, config.apiKey, config.strategy, runs, config.aggregation, signal);
    };

    return {
        audit,
    };
};