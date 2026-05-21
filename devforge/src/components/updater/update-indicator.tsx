import { CheckCircle2, Download, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { UpdateInfo } from '@/hooks/useAppUpdater';

interface Props {
    info: UpdateInfo;
    onRestart: () => void;
    onDismiss?: () => void;
    hidden?: boolean;
}

function formatBytes(bytes: number): string {
    if (bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export function UpdateIndicator({ info, onRestart, onDismiss, hidden }: Props) {
    if (hidden) return null;
    const { state } = info;
    if (state === 'idle' || state === 'error') return null;

    const baseCls =
        'fixed bottom-4 right-4 z-50 w-80 rounded-lg border bg-card text-card-foreground shadow-lg p-3 ' +
        'animate-in slide-in-from-bottom-2 fade-in';

    if (state === 'downloaded') {
        return (
            <div className={baseCls} role="status" aria-live="polite">
                <div className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-500 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium">
                            Update {info.version ? `v${info.version} ` : ''}ready
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                            Restart devForge to apply.
                        </div>
                        <div className="mt-2 flex gap-2">
                            <Button size="sm" className="h-7 text-xs" onClick={onRestart}>
                                Restart Now
                            </Button>
                            {onDismiss && (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 text-xs"
                                    onClick={onDismiss}
                                >
                                    Later
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    const isPreparing = state === 'available' || (state === 'downloading' && info.percent === 0);
    const label = isPreparing
        ? 'Preparing update…'
        : `Downloading update… ${info.percent}%`;
    const sub =
        state === 'downloading' && info.total > 0
            ? `${formatBytes(info.transferred)} / ${formatBytes(info.total)}`
            : info.version
                ? `v${info.version}`
                : '';

    return (
        <div className={baseCls} role="status" aria-live="polite">
            <div className="flex items-center gap-2 mb-2">
                <Download className="h-4 w-4 text-primary flex-shrink-0" />
                <span className="text-sm font-medium flex-1 truncate">{label}</span>
                {onDismiss && (
                    <button
                        type="button"
                        onClick={onDismiss}
                        aria-label="Hide"
                        className="text-muted-foreground hover:text-foreground transition-colors"
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                {isPreparing ? (
                    <div className="h-full w-1/3 bg-primary animate-pulse rounded-full" />
                ) : (
                    <div
                        className="h-full bg-primary transition-all duration-300 rounded-full"
                        style={{ width: `${info.percent}%` }}
                    />
                )}
            </div>
            {sub && <div className="mt-1.5 text-xs text-muted-foreground">{sub}</div>}
        </div>
    );
}
