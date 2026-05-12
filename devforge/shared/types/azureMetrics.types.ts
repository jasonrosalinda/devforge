export interface MetricSeries {
  avg: number
  max: number
  series: Array<{ t: string; v: number; m: number }>
}

export interface InstanceInfo {
  name: string
  zone: string
  healthStatus: string
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
  requests?: { total: number } | null
  failedRequests?: { total: number } | null
  failedRequestsSeries?: Array<{ t: string; count: number }> | null
  http4xxSeries?: Array<{ t: string; count: number }> | null
  instanceHealthSeries?: Array<{ name: string; series: Array<{ t: string; v: number }> }> | null
  instanceProbeSeries?: Array<{ name: string; series: Array<{ t: string; v: number }> }> | null
  requestInsights?: {
    urls?: Array<{ url: string; rpm: number; count: number }>
    ips?: Array<{ ip: string; rpm: number; count: number }>
    userAgents?: Array<{ userAgent: string; rpm: number; count: number }>
    bots?: Array<{ userAgent: string; rpm: number; count: number }>
    highFreq?: Array<{ timestamp: string; lastSeen?: string; ip: string; country: string; userAgent: string; count: number; rpm: number }>
    failedUrls?: Array<{ url: string; rpm: number; count: number }>
    error?: string
  } | null
  responseTime?: { avg: number; max: number; series?: Array<{ t: string; avg: number }> } | null
  requestsSeries?: Array<{ t: string; count: number }> | null
  availability?: {
    pct: number
    downtimeMins: number
    incidents: number
    downtimeIntervals: Array<{ start: number; end: number; cause?: string }>
    series: Array<{ t: string; v: number }>
  } | null
  failedDependencies?: Array<{ t: string; name: string; type: string; target: string; failCount: number; avgDuration: number }> | null
  appInsightsConfigured?: boolean
  error?: string
}

export interface IAzureMetricsAPI {
  checkCredential: () => Promise<{ ok: boolean; error?: string }>
  fetch: (opts: { appKeys: string[]; range: string; config?: unknown; customStart?: string; customEnd?: string; granularity?: string }) => Promise<Record<string, AppMetrics>>
}
