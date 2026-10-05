// Shared Confluence access UI for the runbook pages: the token / session pills
// in the page header, and the banner shown until credentials exist.

import { Loader2, LogIn, RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import { Hint } from '@/components/ui/hint';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSettingsUi } from '@/context/settings-ui-context';
import type { ConfluenceConnection } from '@/hooks/useConfluenceConnection';
import { TokenStatusPill } from './tokenStatusPill';

export function ConfluenceConnectionPills({ conn }: { conn: ConfluenceConnection }) {
  return (
    <div className="flex items-center gap-2">
      <TokenStatusPill status={conn.tokenStatus} onRecheck={() => void conn.checkToken()} />
      {conn.connecting ? (
        <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Connecting…
        </span>
      ) : conn.connected ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="inline-flex items-center gap-1.5 rounded-full border border-success/60 bg-success/10 px-3 py-1 text-xs text-success hover:bg-success/20 transition-colors">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
              Connected
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void conn.disconnect()} className="text-destructive focus:text-destructive">
              <LogIn className="h-3.5 w-3.5 mr-2 rotate-180" /> Disconnect
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-card px-3 py-1 text-xs text-destructive hover:bg-accent transition-colors">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-destructive" />
              Not connected
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div className="px-2 py-1.5 text-xs text-muted-foreground">Screenshots need a Confluence session.</div>
            <DropdownMenuItem onClick={() => void conn.connect()}>
              <RefreshCw className="h-3.5 w-3.5 mr-2" /> Connect Confluence
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function ConfluenceCredsBanner() {
  const { openSettings } = useSettingsUi();
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
      <SettingsIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        Add your Confluence base URL, email, and API token in{' '}
        {/* The fix is one click from the message rather than a place to go find:
            this banner is the only thing on the page until the creds exist. */}
        <Hint label="Open Settings on the Atlassian tab">
          <button
            type="button"
            onClick={() => openSettings('atlassian')}
            className="font-medium text-info underline underline-offset-2 hover:opacity-80"
          >
            Settings → Atlassian
          </button>
        </Hint>{' '}
        before loading a runbook.
      </span>
    </div>
  );
}
