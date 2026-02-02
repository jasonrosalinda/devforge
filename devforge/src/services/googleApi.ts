import type { PageSpeedErrorResponse, PageSpeedMetrics } from "../types/pageSpeedInsight.types";
import type { ApiError } from "../types/common.types";

const API_BASE_URL = "https://www.googleapis.com";

interface PageSpeedApiResponse {
  lighthouseResult?: {
    audits?: Record<
      string,
      {
        displayValue?: string;
        numericValue?: number;
        numericUnit?: string;
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
        totalBlockingTime: {
          displayValue: audits?.["total-blocking-time"]?.displayValue ?? "",
          numericValue: audits?.["total-blocking-time"]?.numericValue ?? 0,
          numericUnit: audits?.["total-blocking-time"]?.numericUnit ?? "",
        },
        firstContentfulPaint: {
          displayValue: audits?.["first-contentful-paint"]?.displayValue ?? "",
          numericValue: audits?.["first-contentful-paint"]?.numericValue ?? 0,
          numericUnit: audits?.["first-contentful-paint"]?.numericUnit ?? "",
        },
        speedIndex: {
          displayValue: audits?.["speed-index"]?.displayValue ?? "",
          numericValue: audits?.["speed-index"]?.numericValue ?? 0,
          numericUnit: audits?.["speed-index"]?.numericUnit ?? "",
        },
        largestContentfulPaint: {
          displayValue: audits?.["largest-contentful-paint"]?.displayValue ?? "",
          numericValue: audits?.["largest-contentful-paint"]?.numericValue ?? 0,
          numericUnit: audits?.["largest-contentful-paint"]?.numericUnit ?? "",
        },
        cumulativeLayoutShift: {
          displayValue: audits?.["cumulative-layout-shift"]?.displayValue ?? "",
          numericValue: audits?.["cumulative-layout-shift"]?.numericValue ?? 0,
          numericUnit: audits?.["cumulative-layout-shift"]?.numericUnit ?? "",
        },
        runWarnings: warnings ?? "",
      };
    }
    catch (error) {
      return {
        totalBlockingTime: {
          displayValue: "",
          numericValue: 0,
          numericUnit: "",
        },
        firstContentfulPaint: {
          displayValue: "",
          numericValue: 0,
          numericUnit: "",
        },
        speedIndex: {
          displayValue: "",
          numericValue: 0,
          numericUnit: "",
        },
        largestContentfulPaint: {
          displayValue: "",
          numericValue: 0,
          numericUnit: "",
        },
        cumulativeLayoutShift: {
          displayValue: "",
          numericValue: 0,
          numericUnit: "",
        },
        runWarnings: "",
        errorResponse: error as PageSpeedErrorResponse,
      };
    }

  }
}

export const googleApi = new GoogleApiService();
