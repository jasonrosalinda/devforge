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
  anthropicApiKey: string;
  uptimeRobotApiKey: string;
}

export interface AppSettings {
  azure: AzureSettings;
  apiKeys: ApiKeysSettings;
}
