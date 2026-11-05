// "Reload App Health Check", raised when a tray alert is clicked (to now) or when the
// Release Verdict / Home's Fleet Pulse asks for a specific window. App opens the tab and
// calls requestHealthCheckReload(); a request made before the page mounts is held.
import { createHandoff } from './handoff';

/** Absent = today 00:00 → now. */
export interface HealthCheckRange { startMs: number; endMs: number }
/** Which apps to show; absent = keep the current selection. */
export interface HealthCheckReload { range?: HealthCheckRange | undefined; appKeys?: string[] | undefined }

const handoff = createHandoff<HealthCheckReload>();

export const requestHealthCheckReload = (req: HealthCheckReload = {}): void => handoff.request(req);

/** Returns an unsubscribe. A held request is delivered to `cb` straight away. */
export const onHealthCheckReload = (cb: (req: HealthCheckReload) => void): (() => void) => handoff.subscribe(cb);
