import { useState } from "react";
import type {
    PageSpeedMetrics,
    PageSpeedInsightResult,
    PageSpeedInsightConfig,
    UsePageSpeedInsightHooks,
    PageSpeedErrorResponse
} from "@/types/pageSpeedInsight.types";
import { googleApi } from "@/services/googleApi";
import { Toast } from "@/components/ui/toast";

export const usePageSpeedInsight = (): UsePageSpeedInsightHooks => {
    const [config, setConfig] = useState<PageSpeedInsightConfig>({
        apiKey: "",
        strategy: "mobile",
    });

    const [results, setResults] = useState<PageSpeedInsightResult[]>([]);
    const toast = Toast();

    const getPageSpeedMetrics = async (url: string): Promise<PageSpeedMetrics> => {
        const strategy = config.strategy?.toLowerCase() === "mobile" ? "mobile" : "desktop";
        return await googleApi.runPagespeed(url, config.apiKey, strategy);
    };

    const updateResult = (
        url: string,
        type: 'before' | 'after',
        generating: boolean,
        metrics?: PageSpeedMetrics
    ) => {
        setResults((prev) => {
            const existingIndex = prev.findIndex((r) => r.url === url);

            if (existingIndex !== -1) {
                const updated = [...prev];
                const existingItem = updated[existingIndex];

                if (existingItem) {
                    if (type === 'before') {
                        updated[existingIndex] = {
                            url: existingItem.url,
                            before: metrics || existingItem.before,
                            after: existingItem.after,
                            generatingBefore: generating,
                            generatingAfter: existingItem.generatingAfter,
                        };
                    } else {
                        updated[existingIndex] = {
                            url: existingItem.url,
                            before: existingItem.before,
                            after: metrics || existingItem.after,
                            generatingBefore: existingItem.generatingBefore,
                            generatingAfter: generating,
                        };
                    }
                }
                return updated;
            } else {
                const newResult: PageSpeedInsightResult = {
                    url,
                    before: type === 'before' ? (metrics || null) : null,
                    after: type === 'after' ? (metrics || null) : null,
                    generatingBefore: type === 'before' && generating,
                    generatingAfter: type === 'after' && generating,
                };
                return [...prev, newResult];
            }
        });
    };

    const generateBefore = async (url: string): Promise<void> => {
        if (!config.apiKey) {
            toast.error("API Key is required");
            return;
        }

        if (!url) {
            toast.error("Please provide a URL");
            return;
        }

        try {
            toast.info(`Running 'Pre-release' pagespeed for ${url}...`);
            updateResult(url, 'before', true);

            const metrics = await getPageSpeedMetrics(url);
            updateResult(url, 'before', false, metrics);
            toast.success(`Pre-release pagespeed run completed for ${url}!`);
        } catch (err) {
            const error = err as PageSpeedErrorResponse;
            console.error("Error during Pre-release pagespeed run:", err);
            updateResult(url, 'before', false);
            toast.error(`Failed: ${error.message || "Unknown error"}`);
        }
    };

    const generateAfter = async (url: string): Promise<void> => {
        if (!config.apiKey) {
            toast.error("API Key is required");
            return;
        }

        if (!url) {
            toast.error("Please provide a URL");
            return;
        }

        const existingResult = results.find((r) => r.url === url);
        if (!existingResult || !existingResult.before) {
            toast.error("Please run 'Pre-release' pagespeed run first");
            return;
        }

        try {
            toast.info(`Running 'Post-release' pagespeed run for ${url}...`);
            updateResult(url, 'after', true);

            const metrics = await getPageSpeedMetrics(url);
            updateResult(url, 'after', false, metrics);
            toast.success(`Post-release pagespeed run completed for ${url}!`);
        } catch (err) {
            const error = err as PageSpeedErrorResponse;
            console.error("Error during Post-release pagespeed run:", err);
            updateResult(url, 'after', false);
            toast.error(`Failed: ${error.message || "Unknown error"}`);
        }
    };

    const generate = async (urls: string[]): Promise<void> => {
        for (const url of urls) {
            await generateBefore(url);
        }
    };

    const setApiKey = (apiKey: string) => {
        setConfig((prev: PageSpeedInsightConfig) => ({ ...prev, apiKey }));
    };

    const setStrategy = (strategy: string) => {
        setConfig((prev: PageSpeedInsightConfig) => ({ ...prev, strategy }));
    };

    const reset = () => {
        setResults([]);
    };

    const removeResult = (url: string) => {
        setResults((prev) => prev.filter((r) => r.url !== url));
    };

    return {
        config,
        result: results,
        generate,
        generateBefore,
        generateAfter,
        setApiKey,
        setStrategy,
        reset,
        removeResult,
    } as UsePageSpeedInsightHooks & {
        generateBefore: (url: string) => Promise<void>;
        generateAfter: (url: string) => Promise<void>;
        setApiKey: (apiKey: string) => void;
        setStrategy: (strategy: string) => void;
        reset: () => void;
        removeResult: (url: string) => void;
    };
};