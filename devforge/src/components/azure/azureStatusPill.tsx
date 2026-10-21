import { Copy, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Hint } from '@/components/ui/hint';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export type CredStatus = 'checking' | 'ok' | 'error';

/** Azure CLI sign-in state, with the `az login` command and a re-check one click away. */
export function AzureStatusPill({
    credStatus,
    credError,
    onRecheck,
}: {
    credStatus: CredStatus;
    credError: string | null;
    onRecheck: () => void;
}) {
    const copyAzLogin = () => {
        navigator.clipboard.writeText('az login');
        toast.info('Copied `az login`', { description: 'Run it in your terminal, then click "Re-check".' });
    };

    if (credStatus === 'checking') {
        return (
            <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Checking…
            </span>
        );
    }

    if (credStatus === 'ok') {
        return (
            <DropdownMenu>
                <Hint label="Signed in to Azure CLI - click to re-check">
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            className="inline-flex items-center gap-1.5 rounded-full border border-success/60 bg-success/10 px-3 py-1 text-xs text-success hover:bg-success/20 transition-colors"
                        >
                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
                            Authenticated
                        </button>
                    </DropdownMenuTrigger>
                </Hint>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={onRecheck}>
                        <RefreshCw className="h-3.5 w-3.5 mr-2" /> Re-check
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    }

    return (
        <DropdownMenu>
            <Hint label={credError || 'Azure CLI not authenticated - click for the sign-in command'}>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-card px-3 py-1 text-xs text-destructive hover:bg-accent transition-colors"
                    >
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-destructive" />
                        Not authenticated
                    </button>
                </DropdownMenuTrigger>
            </Hint>
            <DropdownMenuContent align="end" className="w-64">
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    Run this in your terminal, then click Re-check:
                </div>
                <DropdownMenuItem onClick={copyAzLogin} className="font-mono text-xs">
                    <Copy className="h-3.5 w-3.5 mr-2" /> az login
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onRecheck}>
                    <RefreshCw className="h-3.5 w-3.5 mr-2" /> Re-check
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
