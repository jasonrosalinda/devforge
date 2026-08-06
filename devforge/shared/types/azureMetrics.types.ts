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

/** Exceptions over time for one throw site — the first non-framework stack frame,
 *  resolved server-side by the same rule as `getMeaningfulFrame`.
 *
 *  Grouped by code location rather than by endpoint: a component that fails on
 *  every page it appears on is one line here and 300 forgettable rows in an
 *  endpoint list. `bucket` matches the exception tab keys, so one payload serves
 *  all four tabs. */
export interface ExceptionLocationSeries {
  bucket: 'socket' | 'timeout' | 'oom' | 'generic'
  assembly: string
  method: string
  /** Source path from the stack frame. Empty when the SDK shipped no file info. */
  file: string
  /** Sum of itemCount over the window — sampling-corrected, like every other
   *  trueCount in this file. */
  trueCount: number
  series: Array<{ t: string; count: number }>
}

/** One throw site under one exception type — a row of the type drill-down table.
 *
 *  Deliberately not keyed by line: the same defect reports different lines as the
 *  file is edited between deploys, so the lines are collected into a column
 *  instead of splitting one site into several rows. */
export interface ExceptionSiteRow {
  bucket: 'socket' | 'timeout' | 'oom' | 'generic'
  /** Exception type this site threw — the row it appears under. */
  type: string
  assembly: string
  method: string
  file: string
  /** Distinct line numbers seen, ascending. Empty when the frames carried none. */
  lines: number[]
  /** Distinct endpoints that reached this site. */
  endpoints: number
  /** An endpoint name — meaningful only when `endpoints` is 1, since it is
   *  whichever sorts first otherwise. */
  sampleEndpoint: string
  /** Sampling-corrected total over the whole window, not a count of the capped
   *  detail records. */
  trueCount: number
  /** Raw record count behind `trueCount`, for the sampling note. */
  records: number
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
    userAgents?: Array<{ userAgent: string; rpm: number; count: number }>
    bots?: Array<{ userAgent: string; rpm: number; count: number }>
    highFreq?: Array<{ timestamp: string; lastSeen?: string; ip: string; country: string; userAgent: string; count: number; rpm: number }>
    failedUrls?: Array<{ url: string; totalCount: number; count: number; p95: number; p99: number }>
    slowUrls?: Array<{ url: string; avgMs: number; p99Ms: number; maxMs: number; count: number }>
    total4xx?: number | null
    total5xx?: number | null
    snatDetails?: Array<{ timestamp: string; type: string; outerMessage: string; method: string; assembly: string; operation_Name: string; innermostMessage: string; severityLevel: number | null; handledAt: string; cloud_RoleName: string; innermostType: string; innermostMethod: string; parsedStack: string }> | null
    sqlHttpDetails?: Array<{ timestamp: string; type: string; outerMessage: string; method: string; assembly: string; operation_Name: string; innermostMessage: string; severityLevel: number | null; handledAt: string; cloud_RoleName: string; innermostType: string; innermostMethod: string; parsedStack: string }> | null
    errorTypes?: Array<{ type: string; count: number }> | null
    errorCount?: number | null
    errorDetails?: Array<{ timestamp: string; type: string; outerMessage: string; method: string; assembly: string; operation_Name: string; innermostMessage: string; severityLevel: number | null; handledAt: string; cloud_RoleName: string; client_Browser: string; client_OS: string; innermostType: string; innermostMethod: string; parsedStack: string }> | null
    /** Response-time percentiles and per-endpoint timings for THIS site. Per App
     *  Insights resource, so the FE and API each get their own. No longer rendered as
     *  its own row — the Performance section covers latency per endpoint — but still
     *  read by the remarks builder and the incident payload. */
    responseInsights?: ResponseInsights | null
    /** Powers the Performance section. Null on payloads cached before it existed. */
    performance?: EndpointPerformance | null
    /** Powers the Users section. Null on payloads cached before it existed. */
    userInsights?: UserInsights | null
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
    /** Exception volume over time per throw site, all four buckets in one list —
     *  powers the chart above the tab content. Null on payloads cached before it
     *  existed. */
    excLocationSeries?: ExceptionLocationSeries[] | null
    /** KQL bin width behind `excLocationSeries` ("5m", "1h", …), for the axis label. */
    excLocationBin?: string | null
    /** How many throw sites per bucket the query kept, so the UI can say what it
     *  is not showing rather than imply the list is complete. */
    excLocationTopN?: number | null
    /** Why the throw-site query returned nothing. Without it a failed query and an
     *  app with no exceptions both render as an absent chart. */
    excLocationError?: string | null
    /** Throw sites per exception type — powers the type drill-down table. Null on
     *  payloads cached before it existed, which fall back to the endpoint list. */
    excSites?: ExceptionSiteRow[] | null
    /** Sites-per-type cap the query applied. */
    excSiteTopN?: number | null
    /** Why the site table is missing, for the same reason as `excLocationError`. */
    excSiteError?: string | null
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
      /** Socket-layer count — transport failures, no connection established. */
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
  requestsSeries?: Array<{ t: string; count: number }> | null
  availability?: {
    pct: number
    downtimeMins: number
    incidents: number
    downtimeIntervals: Array<{ start: number; end: number; cause?: string }>
    series: Array<{ t: string; v: number }>
  } | null
  appInsightsConfigured?: boolean
  apiRequestInsights?: {
    userAgents?: Array<{ userAgent: string; rpm: number; count: number }>
    bots?: Array<{ userAgent: string; rpm: number; count: number }>
    highFreq?: Array<{ timestamp: string; lastSeen?: string; ip: string; country: string; userAgent: string; count: number; rpm: number }>
    failedUrls?: Array<{ url: string; totalCount: number; count: number; p95: number; p99: number }>
    slowUrls?: Array<{ url: string; avgMs: number; p99Ms: number; maxMs: number; count: number }>
    total4xx?: number | null
    total5xx?: number | null
    snatDetails?: Array<{ timestamp: string; type: string; outerMessage: string; method: string; assembly: string; operation_Name: string; innermostMessage: string; severityLevel: number | null; handledAt: string; cloud_RoleName: string; innermostType: string; innermostMethod: string; parsedStack: string }> | null
    sqlHttpDetails?: Array<{ timestamp: string; type: string; outerMessage: string; method: string; assembly: string; operation_Name: string; innermostMessage: string; severityLevel: number | null; handledAt: string; cloud_RoleName: string; innermostType: string; innermostMethod: string; parsedStack: string }> | null
    errorTypes?: Array<{ type: string; count: number }> | null
    errorCount?: number | null
    errorDetails?: Array<{ timestamp: string; type: string; outerMessage: string; method: string; assembly: string; operation_Name: string; innermostMessage: string; severityLevel: number | null; handledAt: string; cloud_RoleName: string; client_Browser: string; client_OS: string; innermostType: string; innermostMethod: string; parsedStack: string }> | null
    /** Response-time percentiles and per-endpoint timings for THIS site. Per App
     *  Insights resource, so the FE and API each get their own. No longer rendered as
     *  its own row — the Performance section covers latency per endpoint — but still
     *  read by the remarks builder and the incident payload. */
    responseInsights?: ResponseInsights | null
    /** Powers the Performance section. Null on payloads cached before it existed. */
    performance?: EndpointPerformance | null
    /** Powers the Users section. Null on payloads cached before it existed. */
    userInsights?: UserInsights | null
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
    /** Exception volume over time per throw site, all four buckets in one list —
     *  powers the chart above the tab content. Null on payloads cached before it
     *  existed. */
    excLocationSeries?: ExceptionLocationSeries[] | null
    /** KQL bin width behind `excLocationSeries` ("5m", "1h", …), for the axis label. */
    excLocationBin?: string | null
    /** How many throw sites per bucket the query kept, so the UI can say what it
     *  is not showing rather than imply the list is complete. */
    excLocationTopN?: number | null
    /** Why the throw-site query returned nothing. Without it a failed query and an
     *  app with no exceptions both render as an absent chart. */
    excLocationError?: string | null
    /** Throw sites per exception type — powers the type drill-down table. Null on
     *  payloads cached before it existed, which fall back to the endpoint list. */
    excSites?: ExceptionSiteRow[] | null
    /** Sites-per-type cap the query applied. */
    excSiteTopN?: number | null
    /** Why the site table is missing, for the same reason as `excLocationError`. */
    excSiteError?: string | null
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
      /** Socket-layer count — transport failures, no connection established. */
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
  apiAppInsightsConfigured?: boolean
  /** Requests queued waiting for a worker, from the plan's HttpQueueLength metric.
   *  The one saturation signal that is not a utilization percentage. Windows plans
   *  only — null on Linux plans and Container Apps. */
  httpQueue?: MetricSeries | null
  /** Socket/TCP counters for the plan hosting the frontend site. Null for Container Apps. */
  socketMetrics?: SocketCounters | null
  /** Socket/TCP counters for the plan hosting the API site. */
  apiSocketMetrics?: SocketCounters | null
  /** SNAT port charts from App Service Diagnostics for the frontend site. Loaded
   *  on demand, so `undefined` means "not requested yet" and `null` means
   *  "no detector". */
  snat?: SnatResult | null
  /** Same, for the API site. Null when the API shares the frontend's plan: the
   *  detector would return the same numbers, so it is not queried. */
  apiSnat?: SnatResult | null
  /** Restart events for the frontend site — loaded on demand like `snat`. */
  /** Restart events for the API site. */
  /** Whether the API runs on the frontend's App Service plan. Null when there is
   *  no API, or it is a Container App. Decides whether plan-scoped figures (SNAT
   *  ports) are shown once for the app or separately per site. */
  apiSharesPlan?: boolean | null
  error?: string
}

/** Where a site's response time actually goes. Durations are milliseconds. */
export interface ResponseInsights {
  /** Whole-site percentiles. P50 near P99 means everything is slow; a gap means a tail. */
  spread: { count: number; avgMs: number; p50: number; p75: number; p95: number; p99: number; maxMs: number } | null
  /** Endpoints ranked by total time served (count x avg), not by single worst request. */
  byTotalTime: Array<{ url: string; count: number; avgMs: number; p95: number; totalMs: number }>
  /** App Insights `performanceBucket` histogram — the distribution shape. */
  buckets: Array<{ bucket: string; count: number }>
  /** Per worker instance, so one slow worker is distinguishable from a slow plan. */
  byInstance: Array<{ instance: string; count: number; avgMs: number; p95: number; p99: number; maxMs: number }>
  /** Percent of total request time spent inside dependency calls, capped at 100. */
  dependencyShare: number | null
  /** This site's own response timeline — the frontend's ARM metric has no API
   *  equivalent, so the chart is driven from request telemetry instead. */
  series: Array<{ t: string; avgMs: number; p95: number }>
  /** KQL bin width behind `series` (e.g. '5m'), for the chart caption. */
  seriesBin: string | null
  /**
   * The same distributions split by outcome. Successes and failures averaged
   * together hide each other: a burst of instant 500s pulls the overall figures
   * down while the service is broken.
   */
  bySuccess: { ok: LatencyDist | null; failed: LatencyDist | null }
  /**
   * Error taxonomy. `overSlo` counts only successful responses that breached the
   * objective — the policy-failure category — so a slow 500 is not counted twice.
   */
  errors: { total: number; failed: number; fourXx: number; fiveXx: number; overSlo: number } | null
  /** The objective `overSlo` was measured against, in ms. */
  sloMs: number
}

/** One endpoint's whole-window figures — all three golden signals on one row. */
export interface EndpointPerfRow {
  /** Query string stripped, so '/order?id=1' and '/order?id=2' are one endpoint. */
  url: string
  count: number
  /** Requests per minute across the window. */
  rpm: number
  fourXx: number
  fiveXx: number
  avgMs: number
  p95: number
  p99: number
  maxMs: number
}

/**
 * One downstream call made by one endpoint.
 *
 * Attributed via the dependency's `operation_Name` — the request that made the call — so
 * a dependency raised outside any request (startup, a background job) is absent rather
 * than attributed to an arbitrary endpoint.
 *
 * No `url` field: a fetch is already scoped to a single endpoint, so carrying the endpoint
 * on every row would only create a second place for it to disagree with the selection.
 */
export interface EndpointDependency {
  /** 'SQL', 'Http', 'Azure blob', … */
  type: string
  target: string
  /** The call itself — a statement, a path, an operation name. */
  name: string
  count: number
  failCount: number
  avgMs: number
  p95: number
  /** count x avg. The figure to optimise from: frequent-and-quick beats rare-and-slow. */
  totalMs: number
  /** This call over time. Present only for the costliest few — the rest still list, they
   *  just cannot be charted. Buckets with no calls are absent, so the chart draws a gap. */
  series?: Array<{ t: string; count: number; failCount: number; avgMs: number; p95: number }>
}

/** One endpoint's timeline. Buckets with no traffic are absent, not zero-filled. */
export interface EndpointPerfSeries {
  url: string
  points: Array<{ t: string; count: number; c4: number; c5: number; avgMs: number; p95: number }>
}

/**
 * The Performance section's dataset: the ten busiest endpoints, the ten worst 4xx,
 * and every endpoint with a 5xx, merged into one set keyed on the query-stripped URL.
 *
 * The Top / HTTP 4xx / HTTP 5xx lists answer three questions separately, so an
 * endpoint that is busy AND failing AND slow shows up three times with a different
 * metric each time. This carries rate, errors and duration together per endpoint,
 * which is what makes "its latency rose when its errors rose" a visible fact rather
 * than something you cross-reference between tabs.
 */
export interface EndpointPerformance {
  /** Ranked 5xx desc, then 4xx desc, then volume desc — broken outranks busy.
   *
   *  Timelines are NOT here: the chart shows one endpoint at a time, so shipping a
   *  timeline for all ~60 was the largest thing in the details payload to draw one of
   *  them. They arrive per endpoint from `fetchEndpointDetail`, on selection. */
  endpoints: EndpointPerfRow[]
  /** Cap applied to the 5xx arm of the merge. */
  fiveXxCap: number
  /** True when the 5xx list hit `fiveXxCap` and may be trimming endpoints. */
  fiveXxCapped: boolean
}

/** One of the busiest clients by request volume, with enough detail to judge it. */
export interface TopClient {
  ip: string
  /** Azure's geo resolution for the IP. Empty when it cannot resolve one. */
  country: string
  count: number
  rpm: number
  firstSeen: string
  lastSeen: string
  /** Distinct endpoints touched. One endpoint for an hour is a prober; forty is a person. */
  urlCount: number
  fourXx: number
  fiveXx: number
  /** The agent this client presented most often, not an arbitrary one — see Group F2. */
  userAgent: string
  /** How many distinct agents it presented. Above one means rotation. */
  agents: number
}

/**
 * The Users section's dataset — who was on this site, per App Insights resource.
 *
 * Per site rather than per app: the figures this replaced came from a frontend-only
 * query, so an app's API had no user figures anywhere on the card.
 *
 * A "user" is a distinct client IP. That is the only identity request telemetry carries
 * without an auth claim, so it over-counts anyone behind a changing address and
 * under-counts a shared NAT — the section says so rather than implying head-count.
 */
export interface UserInsights {
  /** KQL bin width behind every series here (e.g. '5m'), for the chart caption. */
  bin: string | null
  /** Distinct clients per bucket. KQL `dcount` is approximate by design. */
  series: Array<{ t: string; users: number }>
  topIps: TopClient[]
  /** Per-client request timelines, keyed by IP — what a clicked client row charts. */
  clientSeries: EntitySeries[]
  /** Per-agent request timelines, keyed by the full user agent string. */
  agentSeries: EntitySeries[]
}

/**
 * One client's or agent's requests over time. Buckets with no traffic are absent rather
 * than zero-filled, so the chart draws a gap — which reads as "not seen in this bucket"
 * instead of implying the client was present and made no requests.
 */
export interface EntitySeries {
  key: string
  series: Array<{ t: string; count: number }>
}

/** One outcome's latency distribution. Durations are milliseconds. */
export interface LatencyDist {
  count: number
  p50: number
  p95: number
  p99: number
  maxMs: number
}

/** One SNAT chart: a portal chart title and its per-instance series. */
export interface SnatChart {
  title: string
  series: Array<{ name: string; series: Array<{ t: string; count: number }> }>
}

export interface SnatResult {
  charts: SnatChart[] | null
  /** Detector id the charts came from — null when the site publishes none. */
  detector?: string | null
  /** Bucket width the detector actually returned, in ms, measured from the data. */
  grainMs?: number | null
  /** Bucket width that was asked for (ISO8601, e.g. 'PT1M'). Detectors may ignore it. */
  requestedGrain?: string | null
  error?: string
}

/** One of the detector's written findings — the prose block the portal shows above
 *  the timeline, naming the instance, the time and the cause. */
export interface DetectorFinding {
  status: string
  message: string
  items: Array<{ name: string; html: string; text: string }>
}

/** Restart events for one site: the timeline chart plus the detector's findings. */
export interface RestartResult {
  charts: SnatChart[]
  detector?: string | null
  grainMs?: number | null
  insights?: DetectorFinding[]
}

/** Restart events are per site — a frontend restarting while its API stays up is
 *  exactly the distinction worth seeing. */
export interface RestartFetchResult {
  fe: RestartResult | null
  api: RestartResult | null
  error?: string
}

/** One fetch covers both sites, so expanding either section loads the pair. */
export interface SnatFetchResult {
  fe: SnatResult
  api: SnatResult | null
  /** True when both sites sit on one plan — `api` is null in that case because
   *  the frontend's figures already describe every worker. */
  shared: boolean
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

/** One endpoint's dependency fetch. `deps` is null when the query could not answer. */
export interface EndpointDepsResult {
  /** The endpoint's own request timeline — what the Performance chart draws. */
  series?: EndpointPerfPoint[] | null
  deps: EndpointDependency[] | null
  /** KQL bin width behind every timeline here (e.g. '5m'), for the chart caption. */
  bin?: string | null
  error?: string
}

/** One bucket of one endpoint's traffic. Absent buckets mean no requests, so the chart
 *  draws a gap rather than implying a measured zero. */
export interface EndpointPerfPoint {
  t: string
  count: number
  c4: number
  c5: number
  avgMs: number
  p95: number
}

export interface IAzureMetricsAPI {
  checkCredential: () => Promise<{ ok: boolean; error?: string }>
  fetch: (opts: { appKeys: string[]; range: string; config?: unknown; customStart?: string | undefined; customEnd?: string | undefined; granularity?: string | undefined }) => Promise<Record<string, AppMetrics>>
  fetchAppDetails: (opts: { appKey: string; range: string; config?: unknown; customStart?: string | undefined; customEnd?: string | undefined; granularity?: string | undefined }) => Promise<Pick<AppMetrics, 'requestInsights' | 'apiRequestInsights'>>
  fetchDetectors: (opts: { appInsightsAppId: string; startIso: string; endIso: string }) => Promise<DetectorAnalysisResult>
  fetchSnat: (opts: { appKey: string; range: string; config?: unknown; customStart?: string | undefined; customEnd?: string | undefined; granularity?: string | undefined }) => Promise<SnatFetchResult>
  fetchRestarts: (opts: { appKey: string; range: string; config?: unknown; customStart?: string | undefined; customEnd?: string | undefined; granularity?: string | undefined }) => Promise<RestartFetchResult>
  /** One endpoint's downstream calls. Per endpoint and on demand — see the handler. */
  fetchEndpointDetail: (opts: { appKey: string; endpoint: string; site: 'fe' | 'api'; range: string; config?: unknown; customStart?: string | undefined; customEnd?: string | undefined }) => Promise<EndpointDepsResult>
  onPartial?: (cb: (data: { key: string; result: AppMetrics }) => void) => (() => void)
}
