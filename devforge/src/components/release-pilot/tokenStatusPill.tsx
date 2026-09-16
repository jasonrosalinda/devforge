import { Loader2, RefreshCw, KeyRound, ExternalLink, Settings as SettingsIcon, TriangleAlert } from 'lucide-react';
import { Hint } from '@/components/ui/hint';
import { useSettingsUi } from '@/context/settings-ui-context';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

/** Where Atlassian API tokens are created — the same page for every Cloud site. */
export const TOKEN_PAGE_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

export type TokenState = 'checking' | 'no-base' | 'missing' | 'valid' | 'expired' | 'forbidden' | 'error';

export interface TokenStatus {
  state: TokenState;
  status?: number;
  detail?: string;
  displayName?: string;
  checkedAt?: number;
}

/** True while the token cannot fetch pages — the page should say why, loudly. */
export function tokenBlocked(state: TokenState): boolean {
  return state === 'missing' || state === 'expired' || state === 'forbidden' || state === 'error';
}

function headline(s: TokenStatus): string {
  switch (s.state) {
    case 'expired': return 'API token expired';
    case 'missing': return 'No API token';
    case 'forbidden': return 'API token rejected';
    case 'error': return 'Token check failed';
    default: return 'API token';
  }
}

function reason(s: TokenStatus): string {
  switch (s.state) {
    case 'expired':
      return 'Confluence answered 401 — the token expired, was revoked, or does not match the account email in Settings. Atlassian tokens last a year at most.';
    case 'missing':
      return 'No account email / API token saved in Settings → Atlassian.';
    case 'forbidden':
      return `Confluence answered 403 — the token authenticated but is not allowed to read this site${s.detail ? `: ${s.detail}` : '. A scoped token needs Confluence read access; a classic token has it by default.'}`;
    case 'error':
      return s.detail || 'Could not reach Confluence to validate the token.';
    default:
      return '';
  }
}

/** Numbered steps for creating a token and putting it into devForge. */
export function TokenSteps({ compact = false }: { compact?: boolean }) {
  const { openSettings } = useSettingsUi();
  return (
    <ol className={`list-decimal space-y-1 pl-4 ${compact ? 'text-xs' : 'text-xs'} text-muted-foreground`}>
      <li>
        Open{' '}
        <a
          href={TOKEN_PAGE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-info underline underline-offset-2 hover:opacity-80"
        >
          id.atlassian.com → Security → API tokens
        </a>
        .
      </li>
      <li>Click <span className="text-foreground">Create API token</span> (not “with scopes” — the classic token covers the Confluence REST API this page uses).</li>
      <li>Name it <span className="font-mono text-foreground">devForge</span>, pick an expiry, then <span className="text-foreground">Create</span> and copy the value — Atlassian shows it once.</li>
      <li>
        Paste it into{' '}
        <button
          type="button"
          onClick={() => openSettings('atlassian')}
          className="font-medium text-info underline underline-offset-2 hover:opacity-80"
        >
          Settings → Atlassian
        </button>{' '}
        → <span className="text-foreground">Confluence API Token</span>, with the same account email, and Save.
      </li>
      <li>Come back here and click <span className="text-foreground">Re-check</span> on the token pill.</li>
    </ol>
  );
}

/** Full-width explainer shown when the token can't load pages. */
export function TokenIssueBanner({ status, onRecheck }: { status: TokenStatus; onRecheck: () => void }) {
  if (!tokenBlocked(status.state)) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs">
      <div className="flex items-start gap-2 text-destructive">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          <span className="font-semibold">{headline(status)}</span> — {reason(status)}
        </span>
      </div>
      <div className="border-t border-destructive/20 pt-2">
        <div className="mb-1 font-medium text-foreground">Get a new token:</div>
        <TokenSteps />
      </div>
      <div className="flex gap-3 pt-0.5">
        <a
          href={TOKEN_PAGE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-info underline underline-offset-2 hover:opacity-80"
        >
          <ExternalLink className="h-3 w-3" /> Create token
        </a>
        <button
          type="button"
          onClick={onRecheck}
          className="inline-flex items-center gap-1 text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" /> Re-check
        </button>
      </div>
    </div>
  );
}

/**
 * Header pill for the Confluence API token — green while it works, red the
 * moment it expires. The dropdown carries the fix, so a dead token never leaves
 * the user guessing at a status code.
 */
export function TokenStatusPill({ status, onRecheck }: { status: TokenStatus; onRecheck: () => void }) {
  const { openSettings } = useSettingsUi();

  if (status.state === 'no-base') return null;

  if (status.state === 'checking') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking token…
      </span>
    );
  }

  if (status.state === 'valid') {
    return (
      <DropdownMenu>
        <Hint label={`API token valid${status.displayName ? ` — ${status.displayName}` : ''}. Click to re-check.`}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full border border-success/60 bg-success/10 px-3 py-1 text-xs text-success hover:bg-success/20 transition-colors"
            >
              <KeyRound className="h-3 w-3" />
              Token valid
            </button>
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent align="end" className="w-60">
          {status.displayName && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">Signed as {status.displayName}</div>
          )}
          <DropdownMenuItem onClick={onRecheck}>
            <RefreshCw className="h-3.5 w-3.5 mr-2" /> Re-check
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openSettings('atlassian')}>
            <SettingsIcon className="h-3.5 w-3.5 mr-2" /> Settings → Atlassian
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const warn = status.state === 'error';
  const tone = warn
    ? 'border-warning/50 bg-warning/10 text-warning hover:bg-warning/20'
    : 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20';

  return (
    <DropdownMenu>
      <Hint label={reason(status)}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${tone}`}
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
            {headline(status)}
          </button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="w-80">
        <div className="px-2 py-1.5 text-xs text-muted-foreground">{reason(status)}</div>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          <div className="mb-1 text-xs font-medium text-foreground">Get a new token:</div>
          <TokenSteps compact />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={TOKEN_PAGE_URL} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-3.5 w-3.5 mr-2" /> Create API token
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => openSettings('atlassian')}>
          <SettingsIcon className="h-3.5 w-3.5 mr-2" /> Settings → Atlassian
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onRecheck}>
          <RefreshCw className="h-3.5 w-3.5 mr-2" /> Re-check
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
