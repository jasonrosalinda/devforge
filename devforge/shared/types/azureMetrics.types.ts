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

export interface ExceptionDetail {
  timestamp: string
  type: string
  outerMessage: string
  method: string
  assembly: string
  operation_Name: string
  innermostMessage: string
  severityLevel: number | null
  handledAt: string
  cloud_RoleName: string
  client_Browser: string
  client_OS: string
  innermostType: string
  innermostMethod: string
  parsedStack: string
}

export interface SocketExceptionDetail {
  timestamp: string
  type: string
  outerMessage: string
  method: string
  assembly: string
  operation_Name: string
  innermostMessage: string
  severityLevel: number | null
  handledAt: string
  cloud_RoleName: string
  cloud_RoleInstance: string
  innermostType: string
  innermostMethod: string
  operation_Id: string
  itemCount: number
  parsedStack: string
}

/** Socket-layer exception deep dive. `trueCount` sums itemCount, so it is
 *  corrected for App Insights ingestion sampling; `records` is the raw row count. */
export interface SocketInsights {
  summary: { records: number; trueCount: number; instances: number; operations: number; firstSeen: string; lastSeen: string } | null
  byType: Array<{ exType: string; assembly: string; records: number; trueCount: number }>
  byInstance: Array<{ instance: string; roleName: string; records: number; trueCount: number; operations: number; firstSeen: string; lastSeen: string }>
  timeline: Array<{ t: string; count: number }>
  targets: Array<{ target: string; depType: string; resultCode: string; count: number; avgDuration: number; p95: number }>
  details: SocketExceptionDetail[]
}

/** Application-level timeouts: connection established, caller gave up waiting.
 *  Mutually exclusive with [[SocketInsights]] — a SocketException whose message
 *  says "timed out" is classified as socket, not timeout. */
export interface TimeoutInsights {
  summary: { records: number; trueCount: number; instances: number; operations: number; firstSeen: string; lastSeen: string } | null
  types: Array<{ type: string; count: number; trueCount: number }>
  details: ExceptionDetail[]
  timeline: Array<{ t: string; count: number }>
  /** Exact per-endpoint totals and windows. `details` is capped at 50 records, so
   *  counts derived from it understate; these are computed over the whole window. */
  byEndpoint: Array<{ endpoint: string; records: number; trueCount: number; firstSeen: string; lastSeen: string }>
}

/** Memory exhaustion — `OutOfMemoryException` and the framework's equivalent
 *  messages. Mutually exclusive with the socket and timeout buckets. */
export interface OomInsights {
  summary: { records: number; trueCount: number; instances: number; operations: number; firstSeen: string; lastSeen: string } | null
  details: ExceptionDetail[]
}

/** One outbound socket / TCP state counter, averaged over the selected window. */
export interface SocketMetric {
  name: string
  avg: number
  max: number
  series: Array<{ t: string; v: number; m: number }>
}

/** Socket/TCP counters are published on the App Service Plan, not the site, so
 *  the values cover every site sharing `planName`. */
export interface SocketCounters {
  planName: string
  metrics: SocketMetric[]
}

export interface AppMetrics {
  label: string
  type: 'appservice' | 'containerapp'
  cpu: MetricSeries
  memory: MetricSeries
  cpuUnit: string
  memUnit: string
  dbCpu?: MetricSeries | null
  dbMemory?: MetricSeries | null
  connections?: MetricSeries | null
  apiConnections?: MetricSeries | null
  users?: MetricSeries | null
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
    topDependencies?: Array<{ classification: 'internal' | 'thirdParty' | 'assets'; name: string; type: string; target: string; totalCount: number; failCount: number; avgDuration: number; p95: number; p99: number }> | null
    errorTypes?: Array<{ type: string; count: number }> | null
    errorCount?: number | null
    errorDetails?: Array<{ timestamp: string; type: string; outerMessage: string; method: string; assembly: string; operation_Name: string; innermostMessage: string; severityLevel: number | null; handledAt: string; cloud_RoleName: string; client_Browser: string; client_OS: string; innermostType: string; innermostMethod: string; parsedStack: string }> | null
    /** Dependencies failing with a genuine timeout result code — see
     *  TIMEOUT_RESULT_CODES in electron/ipc/exception-buckets.cjs. */
    dependencyTimeouts?: Array<{ name: string; resultCode: string; type: string; p95: number; maxMs: number; count: number }> | null
    /** Exception types with socket-layer records excluded — powers the Generic tab. */
    errorTypesGeneric?: Array<{ type: string; count: number; trueCount: number }> | null
    /** Exception records with socket-layer records excluded — powers the Generic tab. */
    errorDetailsGeneric?: ExceptionDetail[] | null
    /** Socket-layer records only — powers the Socket tab. */
    socketInsights?: SocketInsights | null
    /** Application-level timeout records only — powers the Timeout tab. */
    timeoutInsights?: TimeoutInsights | null
    /** Out-of-memory records only — powers the OOM tab. */
    oomInsights?: OomInsights | null
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
      /** Socket-layer count — the CPI socket contributor. */
      socketLayerExceptions: number
      /** Application-level timeouts, socket records excluded. */
      timeoutExceptions: number
      /** Out-of-memory, socket and timeout records excluded. */
      oomExceptions: number
      /** None of socket-layer, timeout, or out-of-memory. */
      genericExceptions: number
      /** Every exception row. Equals socket + timeout + generic. Unlike
       *  `errorCount` this is not truncated to the top 10 types. */
      totalExceptions: number
      uniqueUsers: number
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
  failedDependencies?: Array<{ t: string; classification: 'internal' | 'thirdParty' | 'assets'; name: string; type: string; target: string; totalCount: number; failCount: number; avgDuration: number; p95: number; p99: number }> | null
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
    topDependencies?: Array<{ classification: 'internal' | 'thirdParty' | 'assets'; name: string; type: string; target: string; totalCount: number; failCount: number; avgDuration: number; p95: number; p99: number }> | null
    errorTypes?: Array<{ type: string; count: number }> | null
    errorCount?: number | null
    errorDetails?: Array<{ timestamp: string; type: string; outerMessage: string; method: string; assembly: string; operation_Name: string; innermostMessage: string; severityLevel: number | null; handledAt: string; cloud_RoleName: string; client_Browser: string; client_OS: string; innermostType: string; innermostMethod: string; parsedStack: string }> | null
    /** Dependencies failing with a genuine timeout result code — see
     *  TIMEOUT_RESULT_CODES in electron/ipc/exception-buckets.cjs. */
    dependencyTimeouts?: Array<{ name: string; resultCode: string; type: string; p95: number; maxMs: number; count: number }> | null
    /** Exception types with socket-layer records excluded — powers the Generic tab. */
    errorTypesGeneric?: Array<{ type: string; count: number; trueCount: number }> | null
    /** Exception records with socket-layer records excluded — powers the Generic tab. */
    errorDetailsGeneric?: ExceptionDetail[] | null
    /** Socket-layer records only — powers the Socket tab. */
    socketInsights?: SocketInsights | null
    /** Application-level timeout records only — powers the Timeout tab. */
    timeoutInsights?: TimeoutInsights | null
    /** Out-of-memory records only — powers the OOM tab. */
    oomInsights?: OomInsights | null
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
      /** Socket-layer count — the CPI socket contributor. */
      socketLayerExceptions: number
      /** Application-level timeouts, socket records excluded. */
      timeoutExceptions: number
      /** Out-of-memory, socket and timeout records excluded. */
      oomExceptions: number
      /** None of socket-layer, timeout, or out-of-memory. */
      genericExceptions: number
      /** Every exception row. Equals socket + timeout + generic. Unlike
       *  `errorCount` this is not truncated to the top 10 types. */
      totalExceptions: number
      uniqueUsers: number
    } | null
    error?: string
  } | null
  apiFailedDependencies?: Array<{ t: string; classification: 'internal' | 'thirdParty' | 'assets'; name: string; type: string; target: string; totalCount: number; failCount: number; avgDuration: number; p95: number; p99: number }> | null
  apiAppInsightsConfigured?: boolean
  /** Socket/TCP counters for the plan hosting the frontend site. Null for Container Apps. */
  socketMetrics?: SocketCounters | null
  /** Socket/TCP counters for the plan hosting the API site. */
  apiSocketMetrics?: SocketCounters | null
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
  fetch: (opts: { appKeys: string[]; range: string; config?: unknown; customStart?: string | undefined; customEnd?: string | undefined; granularity?: string | undefined }) => Promise<Record<string, AppMetrics>>
  fetchAppDetails: (opts: { appKey: string; range: string; config?: unknown; customStart?: string | undefined; customEnd?: string | undefined; granularity?: string | undefined }) => Promise<Pick<AppMetrics, 'requestInsights' | 'apiRequestInsights' | 'failedDependencies' | 'apiFailedDependencies'>>
  fetchDetectors: (opts: { appInsightsAppId: string; startIso: string; endIso: string }) => Promise<DetectorAnalysisResult>
  onPartial?: (cb: (data: { key: string; result: AppMetrics }) => void) => (() => void)
}
