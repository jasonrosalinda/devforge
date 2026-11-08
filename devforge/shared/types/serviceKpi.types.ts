/** One row of the Service KPI table: an app's web site, or its API. */
export interface ServiceKpiTarget {
    appName: string;
    site: 'web' | 'api';
}

/** One measured figure. `value` null means nothing to show: see `error` or `note`. */
export interface KpiCell {
    value: number | null;
    error?: string | undefined;
    note?: string | undefined;
}

export interface ServiceKpiTargetResult {
    /** Where CPU / memory were read: "Plan <name>" or "Container app". Null when unresolved. */
    scope: string | null;
    cpu: KpiCell;
    memory: KpiCell;
    /** Only for a web target whose app has a database configured. */
    db: KpiCell | null;
    /** Only when the site has an App Insights resource. */
    errors5xx: KpiCell | null;
}

export interface CostLine {
    name: string;
    cost: number;
}

/** A resource group's cost, with its own per-service split. */
export interface ResourceGroupCost extends CostLine {
    services: CostLine[];
}

export type ServiceKpiCost =
    | { ok: true; currency: string; total: number; byService: CostLine[]; byResourceGroup: ResourceGroupCost[] }
    | { ok: false; error: string };

export interface ServiceKpiWindow {
    /** Metric / App Insights window (SGT month), ISO instants. */
    startIso: string;
    endIso: string;
    /** Cost Management window (UTC calendar month), ISO instants. */
    costFrom: string;
    costTo: string;
}

export interface ServiceKpiFetchOptions {
    /** The Azure settings (AzureSettings), passed through like azureMetrics.fetch's `config`. */
    config: unknown;
    window: ServiceKpiWindow;
    targets: ServiceKpiTarget[];
}

export type ServiceKpiFetchResult =
    | { targets: Record<string, ServiceKpiTargetResult>; cost: ServiceKpiCost }
    | { _error: string };

export interface IServiceKpiAPI {
    fetch: (opts: ServiceKpiFetchOptions) => Promise<ServiceKpiFetchResult>;
}
