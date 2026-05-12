export interface AzureAppEntry {
  type: 'appservice' | 'containerapp';
  resourceGroup: string;
  name: string;
  appInsightsAppId?: string;
  uptimeRobotMonitorIds?: string[];
}

export interface AzureSettings {
  subscriptionId: string;
  apps: AzureAppEntry[];
}

export interface MeduSettings {
  apiDomain: string;
}

export interface ApiKeysSettings {
  pagespeedApiKey: string;
  anthropicApiKey: string;
  uptimeRobotApiKey: string;
}

export interface AppSettings {
  azure: AzureSettings;
  medu: MeduSettings;
  apiKeys: ApiKeysSettings;
}
