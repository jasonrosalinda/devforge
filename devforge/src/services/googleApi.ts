import type { PageSpeedErrorResponse, PageSpeedApiResponse, PageSpeedStrategy, PageSpeedInsightResult, PageSpeedConfiguration } from "@shared/types/pageSpeedInsight.types";
import { buildErrorPageSpeedInsightResult, parseToPageSpeedInsightResult } from "@shared/utils/pageSpeedAuditParser";
import { aggregatePageSpeedInsightResults } from "@/lib/pageSpeedUtils";
import { formatMs } from "@shared/utils/formatingHelper";

const API_BASE_URL = "https://www.googleapis.com";

const MIN_RUNS = 1;
const MAX_RUNS = 10;

class GoogleApiService {
  private async request<T>(endpoint: string, options?: RequestInit, signal?: AbortSignal): Promise<T> {
    // An audit is a measurement, never a resource to reuse: a stored response would hand a
    // re-run the same Lighthouse result it was meant to replace.
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      cache: 'no-store',
      ...options,
      ...(signal ? { signal } : {}),
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const error: PageSpeedErrorResponse = await response.json();
      throw error;
    }

    return response.json() as Promise<T>;
  }

  async runPagespeed(
    url: string,
    apiKey: string,
    strategy: PageSpeedStrategy,
    runs: number = MIN_RUNS,
    aggregation: PageSpeedConfiguration['aggregation'] = 'average',
    signal?: AbortSignal,
    warmUp = false,
  ): Promise<PageSpeedInsightResult> {
    const numRuns = Math.min(MAX_RUNS, Math.max(MIN_RUNS, Math.round(runs) || MIN_RUNS));
    const endpoint = `/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&key=${apiKey}&strategy=${strategy}&category=performance&locale=en`;

    const results: PageSpeedInsightResult[] = [];

    // Warm-up: one throwaway audit so a cold CDN/server cache hits it instead of run #1.
    // Its result (or failure) is discarded — only the runs below are recorded.
    if (warmUp) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        await this.request<PageSpeedApiResponse>(endpoint, { method: 'GET' }, signal);
        console.log(`[PageSpeed] warm-up run for ${url} done (discarded)`);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        console.warn(`[PageSpeed] warm-up run for ${url} failed (ignored):`, error);
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    for (let run = 1; run <= numRuns; run++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        const data = await this.request<PageSpeedApiResponse>(endpoint, { method: 'GET' }, signal);
        console.log(`[PageSpeed] result for ${url} run ${run} (${formatMs(data.lighthouseResult?.timing?.total ?? 0)}):`, data);
        const result = parseToPageSpeedInsightResult(
          url,
          data.lighthouseResult?.audits ?? {},
          data.lighthouseResult?.runWarnings,
          {
            performanceScore: Math.round((data.lighthouseResult?.categories?.performance?.score ?? 0) * 100),
            lighthouseVersion: data.lighthouseResult?.lighthouseVersion,
            fetchTime: data.lighthouseResult?.fetchTime,
            testEnvironment: {
              rttMs: data.lighthouseResult?.configSettings?.throttling?.rttMs,
              throughputKbps: data.lighthouseResult?.configSettings?.throttling?.throughputKbps,
              cpuSlowdownMultiplier: data.lighthouseResult?.configSettings?.throttling?.cpuSlowdownMultiplier,
              benchmarkIndex: data.lighthouseResult?.environment?.benchmarkIndex,
              screenWidth: data.lighthouseResult?.configSettings?.screenEmulation?.width,
              screenHeight: data.lighthouseResult?.configSettings?.screenEmulation?.height,
              deviceScaleFactor: data.lighthouseResult?.configSettings?.screenEmulation?.deviceScaleFactor,
            },
          }
        );
        results.push(result);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        console.error(`[PageSpeed] error for ${url} run ${run}:`, error);
        results.push(buildErrorPageSpeedInsightResult(url, error));
      }

      if (run < numRuns) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    return aggregatePageSpeedInsightResults(url, results, aggregation);
  }
}

export const googleApi = new GoogleApiService();