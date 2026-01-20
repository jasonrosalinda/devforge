import { useState } from "react";
import {
    PageSpeedMetrics,
    PageSpeedInsightResult,
    PageSpeedInsightConfig,
    UsePageSpeedInsightHooks,
    PageSpeedErrorResponse
} from "../types/pageSpeedInsight.types";
import { googleApi } from "../services/googleApi";
import { useToast } from "../contexts/ToastContext";

export const usePageSpeedInsight = (): UsePageSpeedInsightHooks => {
    const [config, setConfig] = useState<PageSpeedInsightConfig>({
        apiKey: "",
        strategy: "mobile",
    });

    const [results, setResults] = useState<PageSpeedInsightResult[]>([]);
    const { showToast } = useToast();

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

                if (type === 'before') {
                    updated[existingIndex] = {
                        url: updated[existingIndex].url,
                        before: metrics || updated[existingIndex].before,
                        after: updated[existingIndex].after,
                        generatingBefore: generating,
                        generatingAfter: updated[existingIndex].generatingAfter,
                    };
                } else {
                    updated[existingIndex] = {
                        url: updated[existingIndex].url,
                        before: updated[existingIndex].before,
                        after: metrics || updated[existingIndex].after,
                        generatingBefore: updated[existingIndex].generatingBefore,
                        generatingAfter: generating,
                    };
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
            showToast("API Key is required", "danger");
            return;
        }

        if (!url) {
            showToast("Please provide a URL", "danger");
            return;
        }

        try {
            showToast(`Running 'Pre-release' pagespeed for ${url}...`, "info");
            updateResult(url, 'before', true);

            const metrics = await getPageSpeedMetrics(url);
            updateResult(url, 'before', false, metrics);
            showToast(`Pre-release pagespeed run completed for ${url}!`, "success");
        } catch (err) {
            const error = err as PageSpeedErrorResponse;
            console.error("Error during Pre-release pagespeed run:", err);
            updateResult(url, 'before', false);
            showToast(`Failed: ${error.message || "Unknown error"}`, "danger");
        }
    };

    const generateAfter = async (url: string): Promise<void> => {
        if (!config.apiKey) {
            showToast("API Key is required", "danger");
            return;
        }

        if (!url) {
            showToast("Please provide a URL", "danger");
            return;
        }

        const existingResult = results.find((r) => r.url === url);
        if (!existingResult || !existingResult.before) {
            showToast("Please run 'Pre-release' pagespeed run first", "danger");
            return;
        }

        try {
            showToast(`Running 'Post-release' pagespeed run for ${url}...`, "info");
            updateResult(url, 'after', true);

            const metrics = await getPageSpeedMetrics(url);
            updateResult(url, 'after', false, metrics);
            showToast(`Post-release pagespeed run completed for ${url}!`, "success");
        } catch (err) {
            const error = err as PageSpeedErrorResponse;
            console.error("Error during Post-release pagespeed run:", err);
            updateResult(url, 'after', false);
            showToast(`Failed: ${error.message || "Unknown error"}`, "danger");
        }
    };

    const generate = async (urls: string[]): Promise<void> => {
        for (const url of urls) {
            await generateBefore(url);
        }
    };

    const setApiKey = (apiKey: string) => {
        setConfig((prev) => ({ ...prev, apiKey }));
    };

    const setStrategy = (strategy: string) => {
        setConfig((prev) => ({ ...prev, strategy }));
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