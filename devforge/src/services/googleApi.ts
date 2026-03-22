import type { PageSpeedErrorResponse, PageSpeedApiResponse, PageSpeedStrategy, PageSpeedInsightResult } from "@shared/types/pageSpeedInsight.types";
import { buildErrorPageSpeedInsightResult, parseToPageSpeedInsightResult } from "@shared/utils/pageSpeedAuditParser";
import { getPageSpeedInsightResultAverage } from "@/lib/pageSpeedUtils";
import { formatMs } from "@shared/utils/formatingHelper";

const API_BASE_URL = "https://www.googleapis.com";

const RUN_MODE_COUNT: Record<'single' | 'average', number> = {
  single: 1,
  average: 3,
};

class GoogleApiService {
  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
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
    runMode: 'single' | 'average' = 'single',
  ): Promise<PageSpeedInsightResult> {
    const numRuns = RUN_MODE_COUNT[runMode];
    const endpoint = `/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&key=${apiKey}&strategy=${strategy}&category=performance&locale=en`;

    const results: PageSpeedInsightResult[] = [];

    for (let run = 1; run <= numRuns; run++) {
      try {
        const data = await this.request<PageSpeedApiResponse>(endpoint, { method: 'GET' });
        console.log(`[PageSpeed] result for ${url} run ${run} (${formatMs(data.lighthouseResult?.timing?.total ?? 0)}):`, data);
        const result = parseToPageSpeedInsightResult(
          url,
          data.lighthouseResult?.audits ?? {},
          data.lighthouseResult?.runWarnings,
        );
        results.push(result);
      } catch (error) {
        console.error(`[PageSpeed] error for ${url} run ${run}:`, error);
        results.push(buildErrorPageSpeedInsightResult(url, error));
      }

      if (run < numRuns) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    return getPageSpeedInsightResultAverage(url, results);
  }
}

export const googleApi = new GoogleApiService();