// "Run this saved Ask Telemetry query", raised by the Ctrl+K palette. App opens the tab
// and calls requestTelemetryRun(); a request made before the page mounts is held.
import { createHandoff } from './handoff';

export interface TelemetryRun { queryId: string }

const handoff = createHandoff<TelemetryRun>();

export const requestTelemetryRun = (req: TelemetryRun): void => handoff.request(req);

/** Returns an unsubscribe. A held request is delivered to `cb` straight away. */
export const onTelemetryRun = (cb: (req: TelemetryRun) => void): (() => void) => handoff.subscribe(cb);
