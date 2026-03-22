export function formatMs(ms: number): string {
    if (ms >= 60000) {
        const mins = Math.floor(ms / 60000);
        const secs = ((ms % 60000) / 1000).toFixed(2);
        return `${mins}m ${secs}s`;
    }
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    return `${Math.round(ms)}ms`;
}