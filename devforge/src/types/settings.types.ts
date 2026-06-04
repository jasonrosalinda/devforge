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
