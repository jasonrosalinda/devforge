export interface AzureAppEntry {
  type: 'appservice' | 'containerapp';
  resourceGroup: string;
  name: string;
  appInsightsAppId?: string;
  uptimeRobotMonitorIds?: string[];
  // API
  apiName?: string;
  apiType?: 'appservice' | 'containerapp';
  apiInsightsAppId?: string;
  // Database
  dbName?: string;
  dbServerName?: string;   // Azure SQL logical server name (without .database.windows.net)
  // Network / Edge diagnostics (optional) — require diagnostic settings → Log Analytics
  logAnalyticsWorkspaceId?: string;   // workspace GUID (customerId) for api.loganalytics.io
  appGatewayResourceId?: string;      // /subscriptions/.../providers/Microsoft.Network/applicationGateways/<name>
  frontDoorResourceId?: string;       // AFD (Microsoft.Cdn/profiles) or classic frontDoors resource id
  loadBalancerResourceId?: string;    // /subscriptions/.../providers/Microsoft.Network/loadBalancers/<name>
}

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
