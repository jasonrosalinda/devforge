import type { PageSpeedInsightResult, PageSpeedConfiguration, UsePageSpeedInsightHooks } from "@shared/types/pageSpeedInsight.types";
import { googleApi } from "@/services/googleApi";

export const usePageSpeedInsight = (config: PageSpeedConfiguration): UsePageSpeedInsightHooks => {

    // `warmUp` defaults to the config; single-run re-runs pass false — the cache is warm by then.
    const audit = async (url: string, signal?: AbortSignal, runs: number = config.runs, warmUp: boolean = config.warmUpRun): Promise<PageSpeedInsightResult> => {
        return await googleApi.runPagespeed(url, config.apiKey, config.strategy, runs, config.aggregation, signal, warmUp);
    };

    return {
        audit,
    };
};