export interface AzureSettings {
    dashboardUrl: string;
    timezone: string;
    waitSeconds: number;
    hiDpi: boolean;
    headless: boolean;
}

export interface AzureTileImage {
    name: string;
    title?: string | null; // chart title from .fxc-monitorchartv2-title
    legends?: { metric: string; value: string }[];
    src: string; // data:image/png;base64,...
}

export interface AzureTilesResult {
    images: AzureTileImage[];
    stats: string | null;   // contents of statistic.txt, or null
    url?: string | null;    // URL from config.json
}

export interface AzureDoneResult {
    success: boolean;
    session?: string;    // timestamp folder name, present on success
    error?: string;
}

export interface IAzureAPI {
    // Auth
    saveAuth: (cfg: Partial<AzureSettings>) => Promise<{ success: boolean; error?: string }>;
    authExists: () => Promise<boolean>;

    // Capture
    capture: (cfg: Partial<AzureSettings>) => Promise<{ success: boolean; session?: string; error?: string }>;

    // Gallery
    getSessions: () => Promise<{ id: string; url: string | null }[]>;
    getTiles: (session: string) => Promise<AzureTilesResult>;
    clearSessions: () => Promise<void>;

    // Settings (persisted via electron-store)
    getSettings: () => Promise<Partial<AzureSettings>>;
    saveSettings: (cfg: AzureSettings) => Promise<boolean>;

    // Streaming events — both return an unsubscribe function
    onLog: (cb: (msg: string) => void) => (() => void);
    onDone: (cb: (result: AzureDoneResult) => void) => (() => void);
}
