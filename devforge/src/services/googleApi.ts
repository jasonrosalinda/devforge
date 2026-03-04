import type { PageSpeedErrorResponse, PageSpeedApiResponse, PageSpeedStrategy, PageSpeedInsightResult } from "@shared/types/pageSpeedInsight.types";
import { buildErrorPageSpeedInsightResult, parseToPageSpeedInsightResult } from "@shared/utils/pageSpeedAuditParser";

const API_BASE_URL = "https://www.googleapis.com";

class GoogleApiService {
  private async request<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<T> {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const error: PageSpeedErrorResponse = await response.json();
      throw error;
    }

    return response.json() as Promise<T>;
  }

  async runPagespeed(url: string, apiKey: string, strategy: PageSpeedStrategy): Promise<PageSpeedInsightResult> {
    const endpoint = `/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&key=${apiKey}&strategy=${strategy}`;

    try {

      const data = await this.request<PageSpeedApiResponse>(endpoint, {
        method: "GET",
      });

      return parseToPageSpeedInsightResult(
        url,
        data.lighthouseResult?.audits ?? {},
        data.lighthouseResult?.runWarnings
      );
    }
    catch (error) {
      return buildErrorPageSpeedInsightResult(url, error);
    }
  }
}

export const googleApi = new GoogleApiService();
