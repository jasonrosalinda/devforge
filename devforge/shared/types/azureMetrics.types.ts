export interface MetricSeries {
  avg: number
  max: number
  p99: number
  series: Array<{ t: string; v: number; m: number }>
}

export interface InstanceInfo {
  name: string
  zone: string
  healthStatus: string
  healthPct: number | null
}

export interface AppMetrics {
  label: string
  type: 'appservice' | 'containerapp'
  cpu: MetricSeries
  memory: MetricSeries
  cpuUnit: string
  memUnit: string
  plan?: { sku: string; cores: number; memoryMB: number } | null
  instances?: InstanceInfo[]
  apiInstances?: InstanceInfo[]
  requests?: { total: number } | null
  failedRequests?: { total: number } | null
  failedRequestsSeries?: Array<{ t: string; count: number }> | null
  http4xxSeries?: Array<{ t: string; count: number }> | null
  instanceHealthSeries?: Array<{ name: string; roleName?: string | null; series: Array<{ t: string; v: number }> }> | null
  apiInstanceHealthSeries?: Array<{ name: string; roleName?: string | null; series: Array<{ t: string; v: number }> }> | null
  instanceProbeSeries?: Array<{ name: string; series: Array<{ t: string; v: number }> }> | null
  requestInsights?: {
    urls?: Array<{ url: string; rpm: number; count: number }>
    ips?: Array<{ ip: string; rpm: number; count: number }>
    userAgents?: Array<{ userAgent: string; rpm: number; count: number }>
    bots?: Array<{ userAgent: string; rpm: number; count: number }>
    highFreq?: Array<{ timestamp: string; lastSeen?: string; ip: string; country: string; userAgent: string; count: number; rpm: number }>
    failedUrls?: Array<{ url: string; totalCount: number; count: number; p95: number; p99: number }>
    failed4xxUrls?: Array<{ url: string; totalCount: number; count: number; p95: number; p99: number }>
    failed5xxUrls?: Array<{ url: string; totalCount: number; count: number; p95: number; p99: number }>
    slowUrls?: Array<{ url: string; avgMs: number; p99Ms: number; maxMs: number; count: number }>
    total4xx?: number | null
    total5xx?: number | null
    snatDetails?: Array<{ timestamp: string; type: string; outerMessage: string; method: string; assembly: string; operation_Name: string; innermostMessage: string; severityLevel: number | null; handledAt: string; cloud_RoleName: string; innermostType: string; innermostMethod: string; parsedStack: string }> | null
    sqlHttpDetails?: Array<{ timestamp: string; type: string; outerMessage: string; method: string; assembly: string; operation_Name: string; innermostMessage: string; severityLevel: number | null; handledAt: string; cloud_RoleName: string; innermostType: string; innermostMethod: string; parsedStack: string }> | null
    topDependencies?: Array<{ name: string; type: string; target: string; totalCount: number; failCount: number; avgDuration: number; p95: number; p99: number }> | null
    errorTypes?: Array<{ type: string; count: number }> | null
    errorCount?: number | null
    errorDetails?: Array<{ timestamp: string; type: string; outerMessage: string; method: string; assembly: string; operation_Name: string; innermostMessage: string; severityLevel: number | null; handledAt: string; cloud_RoleName: string; client_Browser: string; client_OS: string; innermostType: string; innermostMethod: string; parsedStack: string }> | null
    insight?: {
      summary: string
      totalDependencies: number
      failedDependencies: number
      dependencyFailureRate: number
      dependencyP95: number
      dependencyP99: number
      totalRequests: number
      failedRequests: number
      requestFailureRate: number
      requestP95: number
      requestP99: number
      socketExceptions: number
    } | null
    error?: string
  } | null
  responseTime?: { avg: number; max: number; p99?: number; series?: Array<{ t: string; avg: number }> } | null
  requestsSeries?: Array<{ t: string; count: number }> | null
  availability?: {
    pct: number
    downtimeMins: number
    incidents: number
    downtimeIntervals: Array<{ start: number; end: number; cause?: string }>
    series: Array<{ t: string; v: number }>
  } | null
  failedDependencies?: Array<{ t: string; name: string; type: string; target: string; totalCount: number; failCount: number; avgDuration: number; p95: number; p99: number }> | null
  appInsightsConfigured?: boolean
  apiRequestInsights?: {
    urls?: Array<{ url: string; rpm: number; count: number }>
    ips?: Array<{ ip: string; rpm: number; count: number }>
    userAgents?: Array<{ userAgent: string; rpm: number; count: number }>
    bots?: Array<{ userAgent: string; rpm: number; count: number }>
    highFreq?: Array<{ timestamp: string; lastSeen?: string; ip: string; country: string; userAgent: string; count: number; rpm: number }>
    failedUrls?: Array<{ url: string; totalCount: number; count: number; p95: number; p99: number }>
    failed4xxUrls?: Array<{ url: string; totalCount: number; count: number; p95: number; p99: number }>
    failed5xxUrls?: Array<{ url: string; totalCount: number; count: number; p95: number; p99: number }>
    slowUrls?: Array<{ url: string; avgMs: number; p99Ms: number; maxMs: number; count: number }>
    total4xx?: number | null
    total5xx?: number | null
    snatDetails?: Array<{ timestamp: string; type: string; outerMessage: string; method: string; assembly: string; operation_Name: string; innermostMessage: string; severityLevel: number | null; handledAt: string; cloud_RoleName: string; innermostType: string; innermostMethod: string; parsedStack: string }> | null
    sqlHttpDetails?: Array<{ timestamp: string; type: string; outerMessage: string; method: string; assembly: string; operation_Name: string; innermostMessage: string; severityLevel: number | null; handledAt: string; cloud_RoleName: string; innermostType: string; innermostMethod: string; parsedStack: string }> | null
    topDependencies?: Array<{ name: string; type: string; target: string; totalCount: number; failCount: number; avgDuration: number; p95: number; p99: number }> | null
    errorTypes?: Array<{ type: string; count: number }> | null
    errorCount?: number | null
    errorDetails?: Array<{ timestamp: string; type: string; outerMessage: string; method: string; assembly: string; operation_Name: string; innermostMessage: string; severityLevel: number | null; handledAt: string; cloud_RoleName: string; client_Browser: string; client_OS: string; innermostType: string; innermostMethod: string; parsedStack: string }> | null
    insight?: {
      summary: string
      totalDependencies: number
      failedDependencies: number
      dependencyFailureRate: number
      dependencyP95: number
      dependencyP99: number
      totalRequests: number
      failedRequests: number
      requestFailureRate: number
      requestP95: number
      requestP99: number
      socketExceptions: number
    } | null
    error?: string
  } | null
  apiFailedDependencies?: Array<{ t: string; name: string; type: string; target: string; totalCount: number; failCount: number; avgDuration: number; p95: number; p99: number }> | null
  apiAppInsightsConfigured?: boolean
  error?: string
}

export interface DetectorResult {
  columns: string[]
  rows: (string | number | boolean | null)[][]
  error?: string
}

export interface DetectorCategory {
  id: string
  label: string
  color: string
  queries: Array<{ name: string; result: DetectorResult }>
}

export interface DetectorAnalysisResult {
  categories: DetectorCategory[]
  error?: string
}

export interface IAzureMetricsAPI {
  checkCredential: () => Promise<{ ok: boolean; error?: string }>
  fetch: (opts: { appKeys: string[]; range: string; config?: unknown; customStart?: string; customEnd?: string; granularity?: string }) => Promise<Record<string, AppMetrics>>
  fetchAppDetails: (opts: { appKey: string; range: string; config?: unknown; customStart?: string; customEnd?: string; granularity?: string }) => Promise<Pick<AppMetrics, 'requestInsights' | 'apiRequestInsights' | 'failedDependencies' | 'apiFailedDependencies'>>
  fetchDetectors: (opts: { appInsightsAppId: string; startIso: string; endIso: string }) => Promise<DetectorAnalysisResult>
  onPartial?: (cb: (data: { key: string; result: AppMetrics }) => void) => (() => void)
}
