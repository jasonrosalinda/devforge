import { PageSpeedErrorResponse, PageSpeedMetrics } from "../types/pageSpeedInsight.types";
import { ApiError } from "../types/common.types";

const API_BASE_URL = "https://www.googleapis.com";

interface PageSpeedApiResponse {
  lighthouseResult?: {
    audits?: Record<
      string,
      {
        numericValue?: number;
      }
    >;
    runWarnings?: string;
  };
}

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

  async runPagespeed(
    url: string,
    apiKey: string,
    strategy: "mobile" | "desktop" = "mobile"
  ): Promise<PageSpeedMetrics> {
    const endpoint =
      `/pagespeedonline/v5/runPagespeed` +
      `?url=${encodeURIComponent(url)}` +
      `&key=${apiKey}` +
      `&strategy=${strategy}`;

    try {

      const data = await this.request<PageSpeedApiResponse>(endpoint, {
        method: "GET",
      });
      const audits = data.lighthouseResult?.audits;
      const warnings = data.lighthouseResult?.runWarnings;

      return {
        totalBlockingTime: audits?.["total-blocking-time"]?.numericValue ?? 0,
        firstContentfulPaint: audits?.["first-contentful-paint"]?.numericValue ?? 0,
        speedIndex: audits?.["speed-index"]?.numericValue ?? 0,
        largestContentfulPaint:
          audits?.["largest-contentful-paint"]?.numericValue ?? 0,
        cumulativeLayoutShift:
          audits?.["cumulative-layout-shift"]?.numericValue ?? 0,
        runWarnings: warnings ?? "",
      };
    }
    catch (error) {
      return {
        totalBlockingTime: 0,
        firstContentfulPaint: 0,
        speedIndex: 0,
        largestContentfulPaint: 0,
        cumulativeLayoutShift: 0,
        runWarnings: "",
        errorResponse: error as PageSpeedErrorResponse,
      };
    }

  }
}

export const googleApi = new GoogleApiService();
