/** Config Diff (electron/ipc/azure-config.cjs). Names and statuses only: values never leave the main process. */

export type ConfigSite = 'web' | 'api';

export interface ConfigSide {
    appKey: string;
    site: ConfigSite;
    /** 'production' or a deployment slot's short name. */
    slot: string;
}

export type ConfigDiffStatus = 'only-left' | 'only-right' | 'same' | 'differs';

export interface ConfigDiffRow {
    name: string;
    kind: 'setting' | 'connstr';
    status: ConfigDiffStatus;
    /** A deployment slot setting: stays with the slot on a swap. */
    sticky: boolean;
    /** Connection string type (SQLAzure, Custom…). */
    type?: string;
}

export interface ConfigDiffResult {
    rows: ConfigDiffRow[];
    errors: { left?: string | undefined; right?: string | undefined };
}

export interface IAzureConfigAPI {
    slots: (opts: { appKey: string; site: ConfigSite; config: unknown }) => Promise<{ slots: string[]; error?: string }>;
    diff: (opts: { left: ConfigSide; right: ConfigSide; config: unknown }) => Promise<ConfigDiffResult>;
}
