import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
    Copy,
    ExternalLink,
    Loader2,
    LogIn,
    LogOut,
    Rocket,
    Settings as SettingsIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSettings } from '@/context/settings-context';
import { PageHeader } from '@/components/layout/page-header';
import { isElectron } from '@/lib/environment';
import type {
    ConfluenceFetchResult,
    ConfluencePageInfo,
} from '@shared/types/confluence.types';

interface DocState {
    url: string;
    loading: boolean;
    error: string | null;
    page: ConfluencePageInfo | null;
    html: string;
}

interface RunbookTask {
    time: string | null;
    description: string;
    assignees: string | null;
    status: string | null;
}

interface RunbookSection {
    sectionName: string;
    date: string;
    tasks: RunbookTask[];
}

interface ReleasePlanHeader {
    title: string;
    date: string | null;
    time: string | null;
}


type ExpiryStatus =
    | { kind: 'unknown' }
    | { kind: 'expired' }
    | { kind: 'expiring'; label: string; hoursLeft: number }
    | { kind: 'ok'; label: string };

interface SessionStatusPillProps {
    signedIn: boolean;
    sessionExpired: boolean;
    silentLoginRunning: boolean;
    signingIn: boolean;
    expiry: ExpiryStatus;
    onSignIn: () => void;
    onSignOut: () => void;
    onReimport: () => void;
}

function SessionStatusPill({
    signedIn,
    sessionExpired,
    silentLoginRunning,
    signingIn,
    expiry,
    onSignIn,
    onSignOut,
    onReimport,
}: SessionStatusPillProps) {
    if (silentLoginRunning) {
        return (
            <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Checking…
            </span>
        );
    }

    if (signedIn) {
        const expiring = expiry.kind === 'expiring';
        const cls = expiring
            ? 'border-amber-500/60 bg-amber-500/10 text-amber-500 hover:bg-amber-500/20'
            : 'border-green-500/60 bg-green-500/10 text-green-500 hover:bg-green-500/20';
        const dotCls = expiring ? 'bg-amber-500' : 'bg-green-500';
        const label = expiring ? `Expires in ${expiry.label}` : 'Authenticated';
        return (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${cls}`}
                    >
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotCls}`} />
                        {label}
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={onReimport}>
                        Re-import browser session
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={onSignOut}>
                        <LogOut className="h-3.5 w-3.5 mr-2" /> Sign out
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    }

    return (
        <Button
            size="sm"
            className="h-7 text-xs"
            onClick={sessionExpired ? onReimport : onSignIn}
            disabled={signingIn}
        >
            {signingIn ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <LogIn className="h-3 w-3 mr-1" />}
            {sessionExpired ? 'Session expired — sign in' : 'Sign in to Confluence'}
        </Button>
    );
}

function classifyExpiry(earliestExpiry: number | null, nowSec: number): ExpiryStatus {
    if (earliestExpiry == null) return { kind: 'unknown' };
    const secondsLeft = earliestExpiry - nowSec;
    if (secondsLeft <= 0) return { kind: 'expired' };
    const hoursLeft = secondsLeft / 3600;
    const label = formatRelative(secondsLeft);
    if (hoursLeft <= 24) return { kind: 'expiring', label, hoursLeft };
    return { kind: 'ok', label };
}

function formatRelative(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
}

function parseReleasePlanHeader(html: string, title: string): ReleasePlanHeader {
    const div = document.createElement('div');
    div.innerHTML = html;
    const text = div.textContent ?? '';

    const dateMatch =
        text.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})\b/i) ||
        text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})\b/i) ||
        text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);

    let date: string | null = null;
    if (dateMatch) {
        date = dateMatch[0];
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            const d = new Date(date);
            date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        }
    }

    const timeMatch = text.match(/\b(\d{1,2}:\d{2}\s*[ap]m|\d{1,2}\s*[ap]m|\d{2}:\d{2})\b/i);
    const time = timeMatch ? timeMatch[0].replace(/\s+/, '') : null;

    return { title, date, time };
}

function parseGoalsSection(html: string): string {
    const div = document.createElement('div');
    div.innerHTML = html;

    const headings = Array.from(div.querySelectorAll('h1,h2,h3,h4,h5,h6'));
    const goalHeading = headings.find((h) =>
        /goal|what to expect|objective|scope/i.test(h.textContent ?? '')
    );

    if (!goalHeading) return html;

    const level = parseInt(goalHeading.tagName[1], 10);
    const nodes: Node[] = [];
    let sibling = goalHeading.nextSibling;
    while (sibling) {
        if (
            sibling instanceof Element &&
            /^H[1-6]$/.test(sibling.tagName) &&
            parseInt(sibling.tagName[1], 10) <= level
        ) break;
        nodes.push(sibling);
        sibling = sibling.nextSibling;
    }

    const fragment = document.createElement('div');
    nodes.forEach((n) => fragment.appendChild(n.cloneNode(true)));
    return fragment.innerHTML;
}

function parseRunbook(html: string): RunbookSection[] {
    const div = document.createElement('div');
    div.innerHTML = html;

    const sections: RunbookSection[] = [];
    const dateRe = /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})\b/i;
    const timeRe = /^(\d{1,2}:\d{2}\s*[ap]m|\d{1,2}\s*[ap]m|\d{2}:\d{2})/i;
    const statusRe = /[-–]\s*(DONE|SCHEDULED|IN PROGRESS|PENDING|CANCELLED)\s*$/i;
    const assigneesRe = /\(([^)]+)\)\s*(?:[-–]\s*(?:DONE|SCHEDULED|IN PROGRESS|PENDING|CANCELLED)\s*)?$/i;

    function parseTaskLine(line: string): RunbookTask | null {
        const trimmed = line.trim();
        if (!trimmed) return null;

        const statusMatch = trimmed.match(statusRe);
        const status = statusMatch ? statusMatch[1].toUpperCase() : null;
        const withoutStatus = status ? trimmed.slice(0, statusMatch!.index).trim() : trimmed;

        const assigneesMatch = withoutStatus.match(assigneesRe);
        const assignees = assigneesMatch ? `(${assigneesMatch[1]})` : null;
        const withoutAssignees = assignees
            ? withoutStatus.slice(0, withoutStatus.lastIndexOf('(')).trim()
            : withoutStatus;

        const timeMatch = withoutAssignees.match(timeRe);
        const time = timeMatch ? timeMatch[0].replace(/\s+/, '').toLowerCase() : null;
        const description = time
            ? withoutAssignees.replace(timeRe, '').replace(/^[-–\s]+/, '').trim()
            : withoutAssignees.replace(/^[-–\s]+/, '').trim();

        if (!description) return null;
        return { time, description, assignees, status };
    }

    const tables = div.querySelectorAll('table');
    if (tables.length > 0) {
        let currentSection: RunbookSection = { sectionName: 'Deployment Runbook', date: '', tasks: [] };
        sections.push(currentSection);
        tables.forEach((table) => {
            table.querySelectorAll('tr').forEach((row) => {
                const cells = Array.from(row.querySelectorAll('td,th')).map((c) => c.textContent?.trim() ?? '');
                if (cells.length === 0) return;
                const rowText = cells.join(' - ');
                const dateMatch = rowText.match(dateRe);
                if (dateMatch) { currentSection.date = dateMatch[0]; return; }
                const task = parseTaskLine(rowText);
                if (task) currentSection.tasks.push(task);
            });
        });
        if (sections.some((s) => s.tasks.length > 0)) return sections.filter((s) => s.tasks.length > 0);
    }

    const allNodes = Array.from(div.childNodes);
    let currentSection: RunbookSection = { sectionName: 'Deployment Runbook', date: '', tasks: [] };
    sections.push(currentSection);

    function processNode(node: Node) {
        if (!(node instanceof Element)) return;
        if (/^H[1-6]$/.test(node.tagName)) {
            const text = node.textContent?.trim() ?? '';
            const dateMatch = text.match(dateRe);
            if (dateMatch) {
                currentSection.date = dateMatch[0];
            } else if (text) {
                currentSection = { sectionName: text, date: currentSection.date, tasks: [] };
                sections.push(currentSection);
            }
        } else if (node.tagName === 'UL' || node.tagName === 'OL') {
            node.querySelectorAll('li').forEach((li) => {
                const task = parseTaskLine(li.textContent ?? '');
                if (task) currentSection.tasks.push(task);
            });
        } else if (node.tagName === 'P') {
            const text = node.textContent?.trim() ?? '';
            const dateMatch = text.match(dateRe);
            if (dateMatch) { currentSection.date = dateMatch[0]; return; }
            const task = parseTaskLine(text);
            if (task) currentSection.tasks.push(task);
        } else {
            node.childNodes.forEach(processNode);
        }
    }

    allNodes.forEach(processNode);
    return sections.filter((s) => s.tasks.length > 0);
}

function renderRunbookToText(sections: RunbookSection[]): string {
    return sections.map((section) => {
        const dateBar = section.date ? `----${section.date}----\n` : '';
        const sectionHeader = `${section.sectionName}\n`;
        const tasks = section.tasks.map((t) => {
            const parts: string[] = [];
            if (t.time) parts.push(t.time);
            parts.push(t.description);
            if (t.assignees) parts.push(t.assignees);
            if (t.status) parts.push(`- ${t.status}`);
            return parts.join(' ');
        });
        return `${dateBar}${sectionHeader}${tasks.join('\n')}`;
    }).join('\n\n');
}

interface UrlInputRowProps {
    label: string;
    value: string;
    onChange: (v: string) => void;
    loading: boolean;
    error: string | null;
    disabled?: boolean;
}

function UrlInputRow({ label, value, onChange, loading, error, disabled }: UrlInputRowProps) {
    return (
        <div className="flex flex-col gap-1">
            <Label className="text-xs flex items-center gap-1.5">
                {label}
                {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
            </Label>
            <Input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={`https://your-workspace.atlassian.net/wiki/spaces/…`}
                className="text-xs font-mono"
                disabled={disabled}
            />
            {error && (
                <p className="text-xs text-destructive">{error}</p>
            )}
        </div>
    );
}

export default function ReleasePilotPage() {
    const { settings, loading: settingsLoading } = useSettings();
    const { confluenceBaseUrl, confluenceEmail, confluenceApiToken } = settings.apiKeys;
    const hasTokenAuth = Boolean(confluenceEmail && confluenceApiToken);

    const emptyDoc = (url = ''): DocState => ({ url, loading: false, error: null, page: null, html: '' });

    const [releasePlan, setReleasePlan] = useState<DocState>(emptyDoc());
    const [releaseNotes, setReleaseNotes] = useState<DocState>(emptyDoc());
    const [deploymentRunbook, setDeploymentRunbook] = useState<DocState>(emptyDoc());
    const [fetchingAll, setFetchingAll] = useState(false);

    const [signedIn, setSignedIn] = useState(false);
    const [signingIn, setSigningIn] = useState(false);
    const [silentLoginState, setSilentLoginState] = useState<'idle' | 'running' | 'done'>('idle');
    const [silentLoginReason, setSilentLoginReason] = useState<string | null>(null);
    const [silentLoginSource, setSilentLoginSource] = useState<'edge' | 'chrome' | null>(null);
    const [earliestExpiry, setEarliestExpiry] = useState<number | null>(null);
    const [sessionExpired, setSessionExpired] = useState(false);
    const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

    const canAuth = signedIn || hasTokenAuth;
    const canFetch = Boolean(confluenceBaseUrl) && canAuth;

    const refreshSession = useCallback(async () => {
        if (!isElectron() || !confluenceBaseUrl) {
            setSignedIn(false);
            setEarliestExpiry(null);
            setSessionExpired(false);
            return false;
        }
        const status = await window.electronAPI.confluence.checkSession({ baseUrl: confluenceBaseUrl });
        const signedInNow = Boolean(status.signedIn);
        setSignedIn(signedInNow);
        setEarliestExpiry(typeof status.earliestExpiry === 'number' ? status.earliestExpiry : null);
        setSessionExpired(Boolean(status.expired));
        return signedInNow;
    }, [confluenceBaseUrl]);

    useEffect(() => {
        const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000);
        return () => clearInterval(t);
    }, []);

    const runSilentLogin = useCallback(async () => {
        if (!isElectron() || !confluenceBaseUrl) return;
        setSilentLoginState('running');
        setSilentLoginReason(null);
        try {
            const res = await window.electronAPI.confluence.trySilentLogin({ baseUrl: confluenceBaseUrl });
            if (res.source) setSilentLoginSource(res.source);
            if (res.success) {
                await refreshSession();
                setSilentLoginReason(null);
            } else {
                setSilentLoginReason(res.error ?? 'Silent login failed.');
            }
        } finally {
            setSilentLoginState('done');
        }
    }, [confluenceBaseUrl, refreshSession]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const already = await refreshSession();
            if (cancelled || already || !confluenceBaseUrl) return;
            await runSilentLogin();
        })();
        return () => {
            cancelled = true;
        };
    }, [refreshSession, runSilentLogin, confluenceBaseUrl]);

    async function handleSignIn() {
        if (!confluenceBaseUrl) {
            toast.error('Set the Confluence base URL in Settings first.');
            return;
        }
        setSigningIn(true);
        try {
            const res = await window.electronAPI.confluence.signIn({ baseUrl: confluenceBaseUrl });
            setSignedIn(Boolean(res.signedIn));
            if (res.signedIn) {
                toast.success('Signed in to Confluence');
            } else if (res.error) {
                toast.error(res.error);
            } else {
                toast.warning('Sign-in window closed before authentication completed.');
            }
        } finally {
            setSigningIn(false);
        }
    }

    async function handleSignOut() {
        if (!confluenceBaseUrl) return;
        await window.electronAPI.confluence.signOut({ baseUrl: confluenceBaseUrl });
        setSignedIn(false);
        toast.info('Confluence session cleared');
    }

    async function handleFetchAll() {
        if (!isElectron()) {
            toast.error('Requires the Electron build to call Confluence.');
            return;
        }
        if (!confluenceBaseUrl) {
            toast.error('Confluence base URL missing. Open Settings → API Keys.');
            return;
        }
        if (!canAuth) {
            toast.error('Not signed in to Confluence.');
            return;
        }

        const authOpts = {
            baseUrl: confluenceBaseUrl,
            ...(confluenceEmail ? { email: confluenceEmail } : {}),
            ...(confluenceApiToken ? { apiToken: confluenceApiToken } : {}),
        };

        async function fetchDoc(
            doc: DocState,
            setDoc: React.Dispatch<React.SetStateAction<DocState>>
        ) {
            if (!doc.url.trim()) return;
            setDoc((d) => ({ ...d, loading: true, error: null, page: null, html: '' }));
            try {
                const result: ConfluenceFetchResult = await window.electronAPI.confluence.fetchPage({
                    url: doc.url.trim(),
                    ...authOpts,
                });
                if (!result.success) {
                    setDoc((d) => ({ ...d, loading: false, error: result.error }));
                } else {
                    setDoc((d) => ({ ...d, loading: false, page: result.page, html: result.html }));
                }
            } catch (e: unknown) {
                setDoc((d) => ({ ...d, loading: false, error: e instanceof Error ? e.message : String(e) }));
            }
        }

        setFetchingAll(true);
        try {
            await Promise.all([
                fetchDoc(releasePlan, setReleasePlan),
                fetchDoc(releaseNotes, setReleaseNotes),
                fetchDoc(deploymentRunbook, setDeploymentRunbook),
            ]);
        } finally {
            setFetchingAll(false);
        }
    }

    const assembledOutput = useMemo(() => {
        if (!releasePlan.page && !deploymentRunbook.page) return null;

        let header: ReleasePlanHeader | null = null;
        let goalsHtml = '';
        let runbookSections: RunbookSection[] = [];

        if (releasePlan.page && releasePlan.html) {
            header = parseReleasePlanHeader(releasePlan.html, releasePlan.page.title);
            goalsHtml = parseGoalsSection(releasePlan.html);
        }

        if (deploymentRunbook.html) {
            runbookSections = parseRunbook(deploymentRunbook.html);
        }

        return { header, goalsHtml, runbookSections };
    }, [releasePlan.page, releasePlan.html, deploymentRunbook.page, deploymentRunbook.html]);

    function buildPlainText(): string {
        if (!assembledOutput) return '';
        const { header, goalsHtml, runbookSections } = assembledOutput;

        const lines: string[] = [];

        if (header) {
            lines.push(`Deployment release notice: ${header.title}`);
            if (header.date || header.time) {
                const dateTime = [header.date, header.time ? `(${header.time} SGT onwards)` : ''].filter(Boolean).join(' - ');
                lines.push(`${header.title} - ${dateTime}`);
            }
            lines.push('');
        }

        if (goalsHtml) {
            lines.push('What to Expect in This Release');
            const div = document.createElement('div');
            div.innerHTML = goalsHtml;
            lines.push(div.textContent?.trim() ?? '');
            lines.push('');
        }

        if (runbookSections.length > 0) {
            lines.push(renderRunbookToText(runbookSections));
        }

        return lines.join('\n');
    }

    async function handleCopy() {
        const text = buildPlainText();
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            toast.success('Copied to clipboard');
        } catch {
            toast.error('Copy failed');
        }
    }

    return (
        <div className="flex flex-col gap-4 h-full min-h-0 overflow-auto">
            <PageHeader
                icon={Rocket}
                title="Release Pilot"
                subtitle="Compose a deployment release notice from Confluence pages."
                actions={
                    !settingsLoading && confluenceBaseUrl ? (
                        <SessionStatusPill
                            signedIn={signedIn}
                            sessionExpired={sessionExpired}
                            silentLoginRunning={silentLoginState === 'running'}
                            signingIn={signingIn}
                            expiry={classifyExpiry(earliestExpiry, nowSec)}
                            onSignIn={handleSignIn}
                            onSignOut={handleSignOut}
                            onReimport={runSilentLogin}
                        />
                    ) : null
                }
            />

            {!settingsLoading && !confluenceBaseUrl && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs flex items-center gap-2">
                    <SettingsIcon className="h-3.5 w-3.5" />
                    <span>
                        Confluence base URL not set. Open Settings → API Keys and add it (e.g. https://your-workspace.atlassian.net).
                    </span>
                </div>
            )}

            {silentLoginReason && !signedIn && !sessionExpired && silentLoginState !== 'running' && (
                <p className="text-xs text-muted-foreground -mt-2">{silentLoginReason}</p>
            )}

            {/* URL inputs */}
            <div className="flex flex-col gap-3">
                <UrlInputRow
                    label="Release Plan"
                    value={releasePlan.url}
                    onChange={(v) => setReleasePlan((d) => ({ ...d, url: v }))}
                    loading={releasePlan.loading}
                    error={releasePlan.error}
                    disabled={fetchingAll}
                />
                <UrlInputRow
                    label="Release Notes"
                    value={releaseNotes.url}
                    onChange={(v) => setReleaseNotes((d) => ({ ...d, url: v }))}
                    loading={releaseNotes.loading}
                    error={releaseNotes.error}
                    disabled={fetchingAll}
                />
                <UrlInputRow
                    label="Deployment Runbook"
                    value={deploymentRunbook.url}
                    onChange={(v) => setDeploymentRunbook((d) => ({ ...d, url: v }))}
                    loading={deploymentRunbook.loading}
                    error={deploymentRunbook.error}
                    disabled={fetchingAll}
                />
                <Button
                    onClick={handleFetchAll}
                    disabled={
                        fetchingAll ||
                        !canFetch ||
                        (!releasePlan.url.trim() && !releaseNotes.url.trim() && !deploymentRunbook.url.trim())
                    }
                    className="self-start"
                >
                    {fetchingAll ? (
                        <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> Fetching…</>
                    ) : (
                        'Fetch All'
                    )}
                </Button>
            </div>

            {/* Assembled output */}
            {assembledOutput && (
                <div className="flex flex-col gap-3 border-t pt-4">
                    <div className="flex justify-end">
                        <Button size="sm" variant="outline" onClick={handleCopy}>
                            <Copy className="h-3.5 w-3.5 mr-1.5" />
                            Copy
                        </Button>
                    </div>

                    <div className="rounded-md border bg-card overflow-hidden">
                        {/* Header block */}
                        {assembledOutput.header && (
                            <div className="px-5 py-4 border-b">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <p className="text-[11px] font-medium text-muted-foreground mb-0.5 uppercase tracking-wide">Deployment release notice</p>
                                        {(assembledOutput.header.date || assembledOutput.header.time) ? (
                                            <p className="text-sm font-bold leading-snug">
                                                {assembledOutput.header.title}
                                                {assembledOutput.header.date ? ` - ${assembledOutput.header.date}` : ''}
                                                {assembledOutput.header.time ? ` (${assembledOutput.header.time} SGT onwards)` : ''}
                                            </p>
                                        ) : (
                                            <>
                                                <p className="text-sm font-bold leading-snug">{assembledOutput.header.title}</p>
                                                <p className="text-xs text-amber-500 mt-1">Could not parse date/time from Release Plan.</p>
                                            </>
                                        )}
                                    </div>
                                    {releasePlan.page?.webUrl && (
                                        <a
                                            href={releasePlan.page.webUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="flex-shrink-0 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-0.5"
                                        >
                                            <ExternalLink className="h-3 w-3" />
                                        </a>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* What to Expect */}
                        {assembledOutput.goalsHtml && (
                            <div className="px-5 py-4 border-b">
                                <p className="text-xs font-semibold mb-2">What to Expect in This Release</p>
                                <div
                                    className="release-pilot-content text-sm leading-relaxed"
                                    dangerouslySetInnerHTML={{ __html: assembledOutput.goalsHtml }}
                                />
                            </div>
                        )}

                        {/* Deployment Runbook */}
                        {assembledOutput.runbookSections.length > 0 ? (
                            <div className="px-5 py-4">
                                {assembledOutput.runbookSections.map((section, si) => (
                                    <div key={si} className={si > 0 ? 'mt-5' : ''}>
                                        <div className="flex items-center gap-2 mb-2">
                                            {section.date && (
                                                <span className="text-[10px] font-mono bg-muted text-muted-foreground px-2 py-0.5 rounded">
                                                    {section.date}
                                                </span>
                                            )}
                                            <p className="text-xs font-semibold">{section.sectionName}</p>
                                            {deploymentRunbook.page?.webUrl && si === 0 && (
                                                <a
                                                    href={deploymentRunbook.page.webUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                                                >
                                                    <ExternalLink className="h-3 w-3" />
                                                </a>
                                            )}
                                        </div>
                                        <div className="flex flex-col gap-0.5 pl-1">
                                            {section.tasks.map((task, ti) => (
                                                <div key={ti} className="flex items-baseline gap-2 text-xs">
                                                    {task.time && (
                                                        <span className="font-mono text-muted-foreground w-14 shrink-0 text-right">{task.time}</span>
                                                    )}
                                                    <span className={task.time ? '' : 'pl-16'}>
                                                        {task.description}
                                                        {task.assignees && (
                                                            <span className="text-muted-foreground ml-1">{task.assignees}</span>
                                                        )}
                                                        {task.status && (
                                                            <span className={
                                                                'ml-1 font-medium ' + (
                                                                    task.status === 'DONE'
                                                                        ? 'text-green-500'
                                                                        : task.status === 'SCHEDULED'
                                                                        ? 'text-blue-500'
                                                                        : 'text-amber-500'
                                                                )
                                                            }>— {task.status}</span>
                                                        )}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : deploymentRunbook.page && !deploymentRunbook.loading ? (
                            <div className="px-5 py-4">
                                <p className="text-xs font-semibold mb-2">Deployment Runbook</p>
                                <div
                                    className="release-pilot-content text-sm leading-relaxed"
                                    dangerouslySetInnerHTML={{ __html: deploymentRunbook.html }}
                                />
                            </div>
                        ) : null}
                    </div>
                </div>
            )}

            <style>{`
                .release-pilot-content h1, .release-pilot-content h2, .release-pilot-content h3, .release-pilot-content h4 { font-weight: 600; margin: 0.75em 0 0.4em; }
                .release-pilot-content h1 { font-size: 1.1rem; }
                .release-pilot-content h2 { font-size: 1rem; }
                .release-pilot-content h3 { font-size: 0.9rem; }
                .release-pilot-content p { margin: 0.35em 0; }
                .release-pilot-content ul { margin: 0.25em 0; padding-left: 1.25em; list-style-type: disc; }
                .release-pilot-content ol { margin: 0.25em 0; padding-left: 1.25em; }
                .release-pilot-content li { margin: 0.25em 0; }
                .release-pilot-content table { border-collapse: collapse; margin: 0.75em 0; width: 100%; }
                .release-pilot-content th, .release-pilot-content td { border: 1px solid hsl(var(--border)); padding: 0.4em 0.6em; vertical-align: top; }
                .release-pilot-content th { background: hsl(var(--muted)); font-weight: 600; text-align: left; }
                .release-pilot-content img { max-width: 100%; height: auto; }
                .release-pilot-content a { color: hsl(var(--primary)); text-decoration: underline; text-underline-offset: 2px; }
                .release-pilot-content code { background: hsl(var(--muted)); padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.85em; }
                .release-pilot-content pre { background: hsl(var(--muted)); padding: 0.75em; border-radius: 4px; overflow-x: auto; }
                .release-pilot-content blockquote { border-left: 3px solid hsl(var(--border)); padding-left: 0.75em; color: hsl(var(--muted-foreground)); margin: 0.5em 0; }
            `}</style>
        </div>
    );
}
