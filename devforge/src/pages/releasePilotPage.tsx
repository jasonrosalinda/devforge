import { useEffect, useMemo, useState } from 'react';
import { Rocket, Loader2, ExternalLink, TriangleAlert, Settings as SettingsIcon, LogIn, RefreshCw, Copy, Download, CheckCircle2, Circle } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSettings } from '@/context/settings-context';
import { parseRunbookSections, collectImageUrls, extractGoals, extractReleaseLabel, extractProdSchedule, type RunbookAttachment } from '@/lib/parse-runbook';
import { RunbookTable } from '@/components/release-pilot/runbookTable';
import { ReleaseSummary, summaryClipboard } from '@/components/release-pilot/releaseSummary';
import { ImageLightbox, type LightboxImage } from '@/components/release-pilot/imageLightbox';

interface RunbookResult {
  ok: boolean;
  error?: string;
  url?: string;
  title?: string;
  version?: number;
  author?: string;
  when?: string;
  spaceKey?: string;
  html?: string;
  attachments?: RunbookAttachment[];
}

// Downscale + JPEG-compress a data URI for clipboard HTML (Teams paste limit).
function shrinkDataUri(src: string, maxW = 600, quality = 0.72): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / (img.naturalWidth || maxW));
      const w = Math.max(1, Math.round((img.naturalWidth || maxW) * scale));
      const h = Math.max(1, Math.round((img.naturalHeight || maxW) * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(src); return; }
      // White matte so transparent PNGs don't go black when flattened.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      try {
        // WebP is ~30% smaller than JPEG at equal quality; fall back to JPEG.
        let out = canvas.toDataURL('image/webp', quality);
        if (!out.startsWith('data:image/webp')) out = canvas.toDataURL('image/jpeg', quality);
        resolve(out);
      } catch {
        resolve(src);
      }
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

// Recently-loaded URL history (plain localStorage — just URLs, not secrets).
const PLAN_HIST_KEY = 'release-pilot:plan-urls';
const RUNBOOK_HIST_KEY = 'release-pilot:runbook-urls';

function loadHistory(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function pushHistory(key: string, url: string): string[] {
  const next = [url, ...loadHistory(key).filter(u => u !== url)].slice(0, 20);
  try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore quota */ }
  return next;
}

export default function ReleasePilotPage() {
  const { settings } = useSettings();
  const { confluenceBaseUrl, email, apiToken } = settings.atlassian;
  const hasCreds = !!(confluenceBaseUrl && email && apiToken);

  const [url, setUrl] = useState('');
  const [planUrl, setPlanUrl] = useState('');
  const [goals, setGoals] = useState<string[]>([]);
  const [releaseLabel, setReleaseLabel] = useState<string>('');
  const [schedule, setSchedule] = useState<{ date: string; time: string }>({ date: '', time: '' });
  const [planHistory, setPlanHistory] = useState<string[]>([]);
  const [runbookHistory, setRunbookHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunbookResult | null>(null);
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  const [imgDebug, setImgDebug] = useState<{ fetched: number; total: number; sampleUrl?: string | undefined; status?: number | undefined; err?: string | undefined; textHead?: string | undefined } | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [activeTab, setActiveTab] = useState('summary');
  const [closure, setClosure] = useState(false);

  async function writeClipboard(plainText: string, html: string, label: string) {
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([plainText], { type: 'text/plain' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(plainText);
      }
      toast.success(`${label} copied`, { description: 'Paste into Teams or email — formatting preserved.' });
    } catch {
      try {
        await navigator.clipboard.writeText(plainText);
        toast.success(`${label} copied (plain text)`);
      } catch {
        toast.error('Copy failed');
      }
    }
  }

  // Copy the whole summary with full-resolution images embedded (no downscale).
  // May exceed Teams' paste cap with many images → then use "no images" + copy
  // each screenshot individually, or Export.
  async function handleCopyFull() {
    const { plainText, html } = summaryClipboard(sections, goals, result?.title, releaseLabel, schedule, undefined, true, closure);
    await writeClipboard(plainText, html, 'Release summary (full-res)');
  }

  // Copy the summary without embedded images — leaves a labeled "[ screenshot ]"
  // gap where each one goes, so you can paste the image into that spot. Always
  // fits Teams (no image bytes).
  async function handleCopyNoImages() {
    const { plainText, html } = summaryClipboard(sections, goals, result?.title, releaseLabel, schedule, undefined, true, closure);
    const placeholder = '<p style="margin:8px 0">&nbsp;</p>'; // blank gap to paste the image into
    const htmlNoImg = html
      .replace(/<a\b[^>]*>\s*<img\b[^>]*>\s*<\/a>/gi, placeholder)
      .replace(/<img\b[^>]*>/gi, placeholder);
    // Blank out the plain-text "[screenshot: …]" lines too.
    const plainNoImg = plainText.split('\n').map(l => (l.trim().startsWith('[screenshot') ? '' : l)).join('\n');
    await writeClipboard(plainNoImg, htmlNoImg, 'Release summary (no images)');
  }

  // Copy a single screenshot as a full-resolution PNG blob — paste straight into
  // Teams (handled as an upload, so no clipboard-HTML size limit).
  async function copyImageToClipboard(src: string) {
    try {
      const img = new Image();
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('load')); img.src = src; });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('ctx');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
      if (!blob) throw new Error('blob');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast.success('Image copied', { description: 'Paste into Teams (full resolution).' });
    } catch {
      toast.error('Image copy failed');
    }
  }

  // Export the full-quality summary (full-res images, no shrink) to an HTML file
  // — bypasses the Teams clipboard paste-size limit. Attach the file in chat.
  async function handleExportSummary() {
    const { html } = summaryClipboard(sections, goals, result?.title, releaseLabel, schedule, undefined, true, closure);
    const res = await window.electronAPI?.confluence?.saveSummary({ html, title: result?.title });
    if (res?.ok) toast.success('Summary exported', { description: res.path });
    else toast.error('Export failed', { description: res?.error });
  }

  // Load saved URL history once.
  useEffect(() => {
    setPlanHistory(loadHistory(PLAN_HIST_KEY));
    setRunbookHistory(loadHistory(RUNBOOK_HIST_KEY));
  }, []);

  // Check Confluence session status on mount / when base URL changes.
  useEffect(() => {
    if (!confluenceBaseUrl) { setConnected(false); return; }
    window.electronAPI?.confluence?.authStatus({ baseUrl: confluenceBaseUrl })
      .then(s => setConnected(!!s?.connected))
      .catch(() => setConnected(false));
  }, [confluenceBaseUrl]);

  async function handleConnect() {
    if (!confluenceBaseUrl || connecting) return;
    setConnecting(true);
    try {
      await window.electronAPI?.confluence?.login({ baseUrl: confluenceBaseUrl });
      const s = await window.electronAPI?.confluence?.authStatus({ baseUrl: confluenceBaseUrl });
      setConnected(!!s?.connected);
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    await window.electronAPI?.confluence?.logout();
    setConnected(false);
  }

  const sections = useMemo(() => {
    if (!result?.ok || !result.html) return [];
    return parseRunbookSections(result.html, result.attachments ?? []);
  }, [result]);

  // Screenshots present in the runbook HTML that matched no downloaded
  // attachment (dropped during parse). Non-zero → a fetch/match gap, not "no image".
  const dropped = useMemo(() => {
    const keys: string[] = [];
    for (const s of sections) for (const row of s.table.rows) for (const c of row) {
      if (c.droppedImageKeys) keys.push(...c.droppedImageKeys);
    }
    return keys;
  }, [sections]);
  const droppedImages = dropped.length;
  // Filenames of attachments we actually downloaded (to compare against the keys).
  const attachmentNames = useMemo(
    () => (result?.attachments ?? []).map(a => a.filename),
    [result],
  );


  async function handleLoad() {
    if (!url.trim() || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setGoals([]);
    setReleaseLabel('');
    setSchedule({ date: '', time: '' });
    try {
      // Release plan (optional) → extract goals + release label.
      if (planUrl.trim()) {
        const planRes = await window.electronAPI?.confluence?.fetchRunbook({
          baseUrl: confluenceBaseUrl,
          email,
          apiToken,
          pageUrl: planUrl.trim(),
        });
        if (planRes?.ok && planRes.html) {
          setGoals(extractGoals(planRes.html));
          setReleaseLabel(extractReleaseLabel(planRes.html));
          setSchedule(extractProdSchedule(planRes.html));
          setPlanHistory(pushHistory(PLAN_HIST_KEY, planUrl.trim()));
        }
      }

      const res = await window.electronAPI?.confluence?.fetchRunbook({
        baseUrl: confluenceBaseUrl,
        email,
        apiToken,
        pageUrl: url.trim(),
      });
      if (!res) {
        setError('Confluence bridge unavailable.');
      } else if (!res.ok) {
        setError(res.error || 'Failed to load runbook.');
      } else {
        setRunbookHistory(pushHistory(RUNBOOK_HIST_KEY, url.trim()));
        // Primary: attachments downloaded by the main process via the REST
        // _links.download path (accepts API-token Basic auth).
        let attachments: RunbookAttachment[] = (res.attachments ?? []).map(a => ({
          filename: a.filename,
          mediaType: a.mediaType,
          isImage: a.isImage,
          dataUri: a.dataUri,
          id: a.id,
          fileId: a.fileId,
          srcUrl: a.srcUrl,
        }));

        const dbg: NonNullable<typeof imgDebug> = {
          fetched: res.attDebug?.downloaded ?? attachments.length,
          total: res.attDebug?.listed ?? attachments.length,
          err: res.attDebug?.firstErr,
          status: res.attDebug?.listStatus,
          sampleUrl: 'REST _links.download',
        };

        // The REST child/attachment list is unreliable — editor "media" images
        // (download-link <img>s) often aren't listed, so REST may return only a
        // macro icon. Fetch every <img> URL in the HTML that REST didn't already
        // cover (by filename) and merge it in, keyed by its source URL.
        if (res.html) {
          const restNames = new Set(attachments.map(a => a.filename.toLowerCase()));
          const baseOf = (u: string) =>
            decodeURIComponent((u.split('?')[0]?.split('/').pop()) || '').toLowerCase();
          const missing = collectImageUrls(res.html).filter(u => {
            const b = baseOf(u);
            return b && !restNames.has(b);
          });
          if (missing.length > 0) {
            const imgRes = await window.electronAPI?.confluence?.fetchImages({ urls: missing });
            const results = imgRes?.results ?? [];
            const failed = results.filter(r => !r.ok);
            const firstFail = failed[0];
            dbg.fetched += results.length - failed.length;
            dbg.total += missing.length;
            if (firstFail) {
              dbg.sampleUrl = firstFail.url;
              dbg.status = firstFail.status;
              dbg.err = firstFail.error;
              dbg.textHead = firstFail.textHead;
            }
            attachments = [
              ...attachments,
              ...results
                .filter(r => r.ok && r.dataUri)
                .map(r => ({
                  filename: r.url.split('/').pop()?.split('?')[0] || 'image',
                  mediaType: r.mediaType || 'image/png',
                  isImage: r.isImage ?? true,
                  dataUri: r.dataUri as string,
                  srcUrl: r.url,
                })),
            ];
          }
        }

        setImgDebug(dbg);
        console.info('[release-pilot] attachments:', attachments.length, 'attDebug:', res.attDebug);
        setResult({ ...res, attachments });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={Rocket}
        title="Release Pilot"
        subtitle="Load a Confluence deployment runbook — activity table + all screenshots, including ones inside expand drawers."
        actions={confluenceBaseUrl ? (
          connecting ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Connecting…
            </span>
          ) : connected ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="inline-flex items-center gap-1.5 rounded-full border border-green-500/60 bg-green-500/10 px-3 py-1 text-xs text-green-500 hover:bg-green-500/20 transition-colors">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
                  Connected
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleDisconnect} className="text-destructive focus:text-destructive">
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
                <DropdownMenuItem onClick={handleConnect}>
                  <RefreshCw className="h-3.5 w-3.5 mr-2" /> Connect Confluence
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        ) : undefined}
      />

      {!hasCreds && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
          <SettingsIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Add your Confluence base URL, email, and API token in <span className="font-medium text-foreground">Settings → Atlassian</span> before loading a runbook.
          </span>
        </div>
      )}


      {/* URL inputs — release plan (goals) + runbook, one Load button */}
      <div className="flex items-stretch gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <Input
            list="rp-plan-urls"
            value={planUrl}
            onChange={e => setPlanUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleLoad(); }}
            placeholder="Release Plan URL (optional) — goals are extracted from this page"
            className="text-xs font-mono"
            disabled={!hasCreds || loading}
          />
          <datalist id="rp-plan-urls">
            {planHistory.map((u, i) => <option key={i} value={u} />)}
          </datalist>
          <Input
            list="rp-runbook-urls"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleLoad(); }}
            placeholder="Deployment Runbook URL — https://your-site.atlassian.net/wiki/spaces/SPACE/pages/123456/…"
            className="text-xs font-mono"
            disabled={!hasCreds || loading}
          />
          <datalist id="rp-runbook-urls">
            {runbookHistory.map((u, i) => <option key={i} value={u} />)}
          </datalist>
        </div>
        <Button onClick={handleLoad} disabled={!hasCreds || loading || !url.trim()} className="gap-1.5 shrink-0 self-stretch h-auto">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
          {loading ? 'Loading…' : 'Load'}
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Image fetch diagnostics */}
      {imgDebug && (
        <details className="rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs">
          <summary className="cursor-pointer select-none px-3 py-2 font-mono text-amber-600 dark:text-amber-400 list-none flex items-center gap-2">
            <span className="font-semibold">Image fetch:</span>
            <span>{imgDebug.fetched}/{imgDebug.total} fetched</span>
            {imgDebug.fetched < imgDebug.total && <span className="text-amber-500">▼ details</span>}
          </summary>
          {imgDebug.fetched < imgDebug.total && (
            <div className="flex flex-col gap-1 border-t border-amber-500/20 px-3 pb-2.5 pt-2">
              <span className="font-mono">first-fail status: {String(imgDebug.status)} · error: {imgDebug.err}</span>
              <span className="font-mono break-all">url: {imgDebug.sampleUrl}</span>
              <span className="font-mono break-all whitespace-pre-wrap">textHead: {imgDebug.textHead || '(none)'}</span>
            </div>
          )}
        </details>
      )}

      {/* Unmatched-screenshot diagnostics — images in the runbook that no
          downloaded attachment matched (so they were dropped during parse). */}
      {droppedImages > 0 && (
        <details className="rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs text-amber-600 dark:text-amber-400">
          <summary className="cursor-pointer select-none px-3 py-2.5 list-none flex items-start gap-2">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {droppedImages} screenshot{droppedImages === 1 ? '' : 's'} couldn’t be matched to a downloaded attachment and {droppedImages === 1 ? 'was' : 'were'} dropped. ▼ keys
            </span>
          </summary>
          <div className="flex flex-col gap-2 border-t border-amber-500/20 px-3 pb-2.5 pt-2">
            <div>
              <div className="font-semibold">Dropped image attributes:</div>
              {dropped.map((k, i) => <div key={i} className="font-mono break-all">{k}</div>)}
            </div>
            <div>
              <div className="font-semibold">Downloaded attachment filenames ({attachmentNames.length}):</div>
              {attachmentNames.length
                ? attachmentNames.map((n, i) => <div key={i} className="font-mono break-all">{n}</div>)
                : <div className="font-mono">(none)</div>}
            </div>
          </div>
        </details>
      )}

      {/* Result */}
      {result?.ok && (
        <div className="flex flex-col gap-4">
          {/* Title + Open in Confluence */}
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold flex-1 min-w-0 truncate">{result.title}</h2>
            {result.url && (
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-xs text-blue-500 hover:underline"
              >
                Open in Confluence <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>

          {/* Runbook sections as tabs */}
          {sections.length > 0 ? (
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <div className="flex items-center justify-between gap-2">
              <TabsList className="h-auto flex-wrap justify-start gap-1 bg-muted/40 px-1 py-1">
                <TabsTrigger value="summary" className="text-xs">Summary</TabsTrigger>
                {sections.map((section, i) => {
                  const total = section.typedRows.length;
                  const done = section.typedRows.filter(r =>
                    /done|complete|success|pass/i.test(r.status?.text ?? '')
                  ).length;
                  const allDone = total > 0 && done === total;
                  const pct = total > 0 ? Math.round((done / total) * 100) : null;
                  return (
                    <TabsTrigger key={i} value={String(i)} className="text-xs gap-1.5">
                      {section.title}
                      {pct !== null && (
                        allDone ? (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-500 border border-emerald-500/30">
                            ✓ Done
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-500 border border-amber-500/30">
                            {pct}%
                          </span>
                        )
                      )}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
              {activeTab === 'summary' && (
                <div className="flex shrink-0 flex-wrap items-center gap-1">
                  <Button
                    size="sm"
                    variant={closure ? 'default' : 'outline'}
                    className={`h-7 gap-1.5 text-xs ${closure ? 'bg-emerald-600 hover:bg-emerald-600/90 text-white' : ''}`}
                    onClick={() => setClosure(v => !v)}
                    title="Toggle Release Closure — adds the closure header and Testing Results sections"
                  >
                    {closure ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
                    Release Closure
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={handleCopyFull} title="Copy summary with full-resolution images (large — may exceed Teams)">
                    <Copy className="h-3.5 w-3.5" /> Copy (full res)
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={handleCopyNoImages} title="Copy summary text only (no screenshots) — always fits Teams">
                    <Copy className="h-3.5 w-3.5" /> Copy (no images)
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={handleExportSummary} title="Export full-quality HTML file (all sections, full-res)">
                    <Download className="h-4 w-4" />
                  </Button>
                </div>
              )}
              </div>
              {sections.map((section, i) => (
                <TabsContent key={i} value={String(i)} className="mt-3">
                  <RunbookTable data={section.table} typedRows={section.typedRows} onImageClick={setLightbox} />
                </TabsContent>
              ))}
              <TabsContent value="summary" className="mt-3">
                <ReleaseSummary sections={sections} goals={goals} releaseTitle={result?.title} releaseLabel={releaseLabel} schedule={schedule} onImageClick={setLightbox} onCopyImage={copyImageToClipboard} closure={closure} />
              </TabsContent>
            </Tabs>
          ) : (
            <p className="text-xs text-muted-foreground">No runbook tables found on this page.</p>
          )}

        </div>
      )}

      <ImageLightbox image={lightbox} onClose={() => setLightbox(null)} onCopy={copyImageToClipboard} />
    </div>
  );
}
