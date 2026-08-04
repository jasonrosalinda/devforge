export interface AzureAppEntry {
  type: 'appservice' | 'containerapp';
  resourceGroup: string;
  name: string;
  /**
   * Platform name — what the service is called to a reader, e.g. "MIMS CPD".
   * Optional so settings written by an older build still load; everything that
   * displays it falls back to `resourceGroup`.
   */
  platformName?: string;
  /** Public URLs for this platform, e.g. ["https://mims-cpd.com"]. */
  platformUrls?: string[];
  appInsightsAppId?: string;
  uptimeRobotMonitorIds?: string[];
  // API
  apiName?: string;
  apiType?: 'appservice' | 'containerapp';
  apiInsightsAppId?: string;
  // Database
  dbName?: string;
  dbServerName?: string;   // Azure SQL logical server name (without .database.windows.net)
  /**
   * Latency objective in milliseconds. A successful response slower than this is
   * a policy failure — the error category most monitoring misses, because the
   * request returned 200. Unset falls back to DEFAULT_SLO_MS; an API and a report
   * page rarely share a target, which is why this is per app.
   */
  sloMs?: number;
  // Network / Edge diagnostics (optional) — require diagnostic settings → Log Analytics
  logAnalyticsWorkspaceId?: string;   // workspace GUID (customerId) for api.loganalytics.io
  appGatewayResourceId?: string;      // /subscriptions/.../providers/Microsoft.Network/applicationGateways/<name>
  frontDoorResourceId?: string;       // AFD (Microsoft.Cdn/profiles) or classic frontDoors resource id
  loadBalancerResourceId?: string;    // /subscriptions/.../providers/Microsoft.Network/loadBalancers/<name>
}

/** Used wherever an app has no explicit `sloMs`. One second is the common
 *  web-request objective and keeps the Errors signal meaningful out of the box. */
export const DEFAULT_SLO_MS = 1000;

export interface AzureSettings {
  subscriptionId: string;
  apps: AzureAppEntry[];
}

export interface ApiKeysSettings {
  pagespeedApiKey: string;
  uptimeRobotApiKey: string;
}

export interface AtlassianSettings {
  confluenceBaseUrl: string;   // e.g. https://mims.atlassian.net
  email: string;               // atlassian account email
  apiToken: string;            // Confluence Cloud API token
}

export interface AppSettings {
  azure: AzureSettings;
  apiKeys: ApiKeysSettings;
  atlassian: AtlassianSettings;
}
