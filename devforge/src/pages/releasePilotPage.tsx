import { useEffect, useMemo, useState } from 'react';
import { Rocket, Loader2, ExternalLink, TriangleAlert, Copy, Download, CheckCircle2, Circle } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Hint } from "@/components/ui/hint";

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useSettings } from '@/context/settings-context';
import { parseRunbookSections, extractGoals, extractReleaseLabel, extractProdSchedule } from '@/lib/parse-runbook';
import { loadRunbook, RUNBOOK_URL_HISTORY_KEY, type ImageFetchStats, type RunbookPage } from '@/lib/load-runbook';
import { loadUrlHistory, pushUrlHistory } from '@/lib/url-history';
import { copyImageToClipboard } from '@/lib/clipboard-image';
import { useConfluenceConnection } from '@/hooks/useConfluenceConnection';
import { RunbookTable } from '@/components/release-pilot/runbookTable';
import { ReleaseSummary, summaryClipboard } from '@/components/release-pilot/releaseSummary';
import { ImageLightbox, type LightboxImage } from '@/components/release-pilot/imageLightbox';
import { TokenIssueBanner } from '@/components/release-pilot/tokenStatusPill';
import { ConfluenceConnectionPills, ConfluenceCredsBanner } from '@/components/release-pilot/confluenceConnection';

type RunbookResult = RunbookPage & { ok: true };

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

// Recently-loaded URL history (the runbook list is shared with Release Runbook).
const PLAN_HIST_KEY = 'release-pilot:plan-urls';

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
  const [imgDebug, setImgDebug] = useState<ImageFetchStats | null>(null);
  const conn = useConfluenceConnection(settings.atlassian);
  const { tokenStatus, tokenDead, checkToken } = conn;
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
    setPlanHistory(loadUrlHistory(PLAN_HIST_KEY));
    setRunbookHistory(loadUrlHistory(RUNBOOK_URL_HISTORY_KEY));
  }, []);

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
          setPlanHistory(pushUrlHistory(PLAN_HIST_KEY, planUrl.trim()));
        }
      }

      const loaded = await loadRunbook(window.electronAPI?.confluence, { baseUrl: confluenceBaseUrl, email, apiToken }, url.trim());
      if (!loaded.ok) {
        setError(loaded.error);
        if (loaded.authFailed) void checkToken();
      } else {
        setRunbookHistory(pushUrlHistory(RUNBOOK_URL_HISTORY_KEY, url.trim()));
        setImgDebug(loaded.imageStats);
        setResult({ ...loaded.page, ok: true });
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
        actions={confluenceBaseUrl ? <ConfluenceConnectionPills conn={conn} /> : undefined}
      />

      {!hasCreds && <ConfluenceCredsBanner />}

      {/* An expired or rejected token fails every load — say so before the user
          pastes a URL, and carry the fix with the message. */}
      {hasCreds && <TokenIssueBanner status={tokenStatus} onRecheck={() => void checkToken()} />}


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
        <Hint
          label={
            !hasCreds
              ? 'Add your Confluence credentials in Settings first'
              : tokenDead
                ? 'The Confluence API token is not usable — replace it in Settings → Atlassian, then Re-check'
                : 'Fetch the runbook from this Confluence page and build the release summary'
          }
        >
          <Button onClick={handleLoad} disabled={!hasCreds || tokenDead || loading || !url.trim()} className="gap-1.5 shrink-0 self-stretch h-auto">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
            {loading ? 'Loading…' : 'Load'}
          </Button>
        </Hint>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Image fetch diagnostics */}
      {imgDebug && (
        <details className="rounded-lg border border-warning/40 bg-warning/10 text-xs">
          <summary className="cursor-pointer select-none px-3 py-2 font-mono text-warning list-none flex items-center gap-2">
            <span className="font-semibold">Image fetch:</span>
            <span>{imgDebug.fetched}/{imgDebug.total} fetched</span>
            {imgDebug.fetched < imgDebug.total && <span className="text-warning">▼ details</span>}
          </summary>
          {imgDebug.fetched < imgDebug.total && (
            <div className="flex flex-col gap-1 border-t border-warning/20 px-3 pb-2.5 pt-2">
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
        <details className="rounded-lg border border-warning/40 bg-warning/10 text-xs text-warning">
          <summary className="cursor-pointer select-none px-3 py-2.5 list-none flex items-start gap-2">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {droppedImages} screenshot{droppedImages === 1 ? '' : 's'} couldn’t be matched to a downloaded attachment and {droppedImages === 1 ? 'was' : 'were'} dropped. ▼ keys
            </span>
          </summary>
          <div className="flex flex-col gap-2 border-t border-warning/20 px-3 pb-2.5 pt-2">
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
                className="inline-flex shrink-0 items-center gap-1 text-xs text-info hover:underline"
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
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold text-success border border-success/30">
                            ✓ Done
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning border border-warning/30">
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
                  <Hint label={closure ? 'Drop the closure header and Testing Results sections from the summary' : 'Add the closure header and Testing Results sections to the summary'}>
                    <Button
                      size="sm"
                      variant={closure ? 'default' : 'outline'}
                      className={`h-7 gap-1.5 text-xs ${closure ? 'bg-success text-success-foreground hover:bg-success/90' : ''}`}
                      onClick={() => setClosure(v => !v)}
                    >
                      {closure ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
                      Release Closure
                    </Button>
                  </Hint>
                  <Hint label="Copy the summary with full-resolution screenshots — large, and may exceed the Teams paste limit">
                    <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={handleCopyFull}>
                      <Copy className="h-3.5 w-3.5" /> Copy (full res)
                    </Button>
                  </Hint>
                  <Hint label="Copy the summary text only, no screenshots — always fits in Teams">
                    <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={handleCopyNoImages}>
                      <Copy className="h-3.5 w-3.5" /> Copy (no images)
                    </Button>
                  </Hint>
                  <Hint label="Export every section as one full-quality HTML file, images at full resolution">
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={handleExportSummary}>
                      <Download className="h-4 w-4" />
                    </Button>
                  </Hint>
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
