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
  responseTime?: { avg: number; max: number } | null
  availability?: {
    pct: number
    downtimeMins: number
    incidents: number
    downtimeIntervals: Array<{ start: number; end: number }>
  } | null
  error?: string
}

export interface IAzureMetricsAPI {
  checkCredential: () => Promise<{ ok: boolean; error?: string }>
  fetch: (opts: { appKeys: string[]; range: string }) => Promise<Record<string, AppMetrics>>
}
