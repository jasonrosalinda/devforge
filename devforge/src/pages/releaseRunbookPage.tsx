import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen, CalendarClock, ExternalLink, FilePlus2, FileStack, Loader2, Save, TriangleAlert, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useSettings } from '@/context/settings-context';
import { useConfluenceConnection } from '@/hooks/useConfluenceConnection';
import { TokenIssueBanner } from '@/components/release-pilot/tokenStatusPill';
import { ConfluenceConnectionPills, ConfluenceCredsBanner } from '@/components/release-pilot/confluenceConnection';
import { RunbookSectionTable } from '@/components/runbook-editor/runbookSectionTable';
import { SaveReviewDialog } from '@/components/runbook-editor/saveReviewDialog';
import { RichTextPanel } from '@/components/runbook-editor/richTextPanel';
import { referencedImages, screenshotName, uploadEach } from '@/lib/runbook-richtext/attachments';
import { maxTaskId } from '@/lib/runbook-richtext/editor-to-storage';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { RUNBOOK_URL_HISTORY_KEY } from '@/lib/load-runbook';
import { loadUrlHistory, pushUrlHistory } from '@/lib/url-history';
import { parseRunbookStorage, serializeRunbookDoc, colIndex, effectiveCell, setCell, ownerRow, type EditDoc, type EditSection } from '@/lib/runbook-model';
import { applySchedule, defaultAnchor, rowSchedule, shiftRunbook, shiftTitleDate, type Anchor } from '@/lib/runbook-schedule';
import { blankRunbookStorage, picsOf, resetForTemplate } from '@/lib/runbook-cells';
import { diffRunbook, type RunbookChange } from '@/lib/runbook-diff';
import { cellText } from '@/lib/runbook-storage';

const TEMPLATE_HIST_KEY = 'runbook-editor:template-urls';
const TEMPLATE_PREFIX = '[Template] ';

type Target =
  | { kind: 'existing'; pageId: string; version: number; url: string; spaceKey: string; parentId: string }
  | { kind: 'new'; spaceKey: string; parentId: string; from: string; sourcePageId: string }; // from: "template" / "blank"; sourcePageId: the template's page ('' for blank)

type DialogKind = 'save' | 'create' | 'template' | null;

const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Every person mentioned in the runbook, for one name lookup.
function mentionedIds(doc: EditDoc): string[] {
  const ids = new Set<string>();
  for (const s of doc.sections) {
    const c = colIndex(s, 'pics');
    if (c < 0) continue;
    s.rows.forEach(row => { if (!row.cells[c]!.sameAsAbove) picsOf(row.cells[c]!.inner).forEach(p => { if ('accountId' in p) ids.add(p.accountId); }); });
  }
  return [...ids];
}

export default function ReleaseRunbookPage() {
  const { settings } = useSettings();
  const { confluenceBaseUrl, email, apiToken } = settings.atlassian;
  const creds = useMemo(() => ({ baseUrl: confluenceBaseUrl, email, apiToken }), [confluenceBaseUrl, email, apiToken]);
  const hasCreds = !!(confluenceBaseUrl && email && apiToken);
  const conn = useConfluenceConnection(settings.atlassian);
  const api = window.electronAPI?.confluence;

  const [openUrl, setOpenUrl] = useState('');
  const [templateUrl, setTemplateUrl] = useState('');
  const [runbookHistory, setRunbookHistory] = useState<string[]>([]);
  const [templateHistory, setTemplateHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [target, setTarget] = useState<Target | null>(null);
  const [original, setOriginal] = useState<EditDoc | null>(null); // as loaded, for the review diff
  const [originalTitle, setOriginalTitle] = useState('');
  const [doc, setDoc] = useState<EditDoc | null>(null);
  const [title, setTitle] = useState('');
  const [dirty, setDirty] = useState(false);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('');

  const [dialog, setDialog] = useState<DialogKind>(null);
  const [dialogTitle, setDialogTitle] = useState('');
  const [parentUrl, setParentUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ by: string; when: string; version?: number | undefined } | null>(null);
  const [lostEdits, setLostEdits] = useState<RunbookChange[] | null>(null);
  const [rich, setRich] = useState<{ section: number; row: number; col: number } | null>(null);
  const [pending, setPending] = useState<Map<string, File>>(new Map()); // pasted screenshots not yet uploaded
  const taskIdRef = useRef(0);
  const previewCache = useRef(new Map<string, Promise<string | null>>());
  const shotSeq = useRef(0);
  // An action waiting on "discard unsaved changes?" (themed dialog, not window.confirm).
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  useEffect(() => {
    setRunbookHistory(loadUrlHistory(RUNBOOK_URL_HISTORY_KEY));
    setTemplateHistory(loadUrlHistory(TEMPLATE_HIST_KEY));
  }, []);

  const learnName = useCallback((id: string, name: string) => {
    setNames(m => (m.get(id) === name ? m : new Map(m).set(id, name)));
  }, []);

  const searchUsers = useCallback(async (query: string) => {
    const res = await api?.searchUsers({ ...creds, query });
    return res?.ok ? res.users ?? [] : [];
  }, [api, creds]);

  const startEditing = useCallback(async (next: EditDoc, nextTitle: string, nextTarget: Target, base: EditDoc | null) => {
    const a = defaultAnchor(next);
    setDoc(next);
    taskIdRef.current = maxTaskId(next.storage);
    previewCache.current.clear();
    setPending(new Map());
    setOriginal(base);
    setTitle(nextTitle);
    setOriginalTitle(base ? nextTitle : '');
    setTarget(nextTarget);
    setAnchor(a ? { section: a.section, row: a.row } : null);
    setStartDate(a?.at.slice(0, 10) ?? todayYmd());
    setStartTime(a?.at.slice(11, 16) ?? '18:00');
    setDirty(base === null);
    const ids = mentionedIds(next);
    if (ids.length) {
      const res = await api?.lookupUsers({ ...creds, accountIds: ids });
      if (res?.ok) setNames(m => { const n = new Map(m); res.users?.forEach(u => n.set(u.accountId, u.displayName)); return n; });
    }
  }, [api, creds]);

  const fetchPage = useCallback(async (url: string) => {
    const res = await api?.getPage({ ...creds, pageUrl: url });
    if (!res) throw new Error('Confluence bridge unavailable.');
    if (!res.ok) {
      if (/\b40[13]\b/.test(res.error ?? '')) void conn.checkToken();
      throw new Error(res.error || 'Failed to load the page.');
    }
    const parsed = parseRunbookStorage(res.storage ?? '');
    if (!parsed.sections.length) throw new Error('No runbook tables on that page (need a table with Time and Activity columns).');
    return { res, parsed };
  }, [api, creds, conn]);

  // Runs `action` now, or after the user agrees to drop unsaved edits.
  const guardDiscard = useCallback((action: () => void) => {
    if (!dirtyRef.current) action();
    else setPendingDiscard(() => action);
  }, []);

  const loadExisting = useCallback(async (url: string) => {
    setLoading(true);
    setError(null);
    try {
      const { res, parsed } = await fetchPage(url);
      setRunbookHistory(pushUrlHistory(RUNBOOK_URL_HISTORY_KEY, res.url || url));
      await startEditing(parsed, res.title ?? '', {
        kind: 'existing', pageId: res.pageId!, version: res.version ?? 1, url: res.url || url,
        spaceKey: res.spaceKey ?? '', parentId: res.parentId ?? '',
      }, parsed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [fetchPage, startEditing]);

  async function newFromTemplate() {
    if (!templateUrl.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const { res, parsed } = await fetchPage(templateUrl.trim());
      setTemplateHistory(pushUrlHistory(TEMPLATE_HIST_KEY, res.url || templateUrl.trim()));
      const base = (res.title ?? '').replace(/^\[Template\]\s*/i, '');
      await startEditing(resetForTemplate(parsed), base, {
        kind: 'new', spaceKey: res.spaceKey ?? '', parentId: res.parentId ?? '', from: `template “${res.title}”`, sourcePageId: res.pageId ?? '',
      }, null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function newBlank() {
    setError(null);
    const today = todayYmd();
    await startEditing(parseRunbookStorage(blankRunbookStorage(today)), shiftTitleDate('1 Jan 2000 Deployment Runbook', today),
      { kind: 'new', spaceKey: '', parentId: '', from: 'blank', sourcePageId: '' }, null);
  }

  function closeEditor() {
    guardDiscard(() => {
      setDoc(null);
      setOriginal(null);
      setTarget(null);
      setDirty(false);
      setLostEdits(null);
    });
  }

  // Where existing screenshots live: the page being edited, or the template a new page came from.
  const sourcePageId = target?.kind === 'existing' ? target.pageId : target?.sourcePageId ?? '';

  const loadPreview = useCallback((filename: string) => {
    const hit = previewCache.current.get(filename);
    if (hit) return hit;
    const local = pending.get(filename);
    const p = local
      ? Promise.resolve(URL.createObjectURL(local))
      : sourcePageId
        ? api?.fetchAttachment({ ...creds, pageId: sourcePageId, filename }).then(r => (r.ok ? r.dataUri ?? null : null)) ?? Promise.resolve(null)
        : Promise.resolve(null);
    previewCache.current.set(filename, p);
    return p;
  }, [api, creds, pending, sourcePageId]);

  const addImage = useCallback((file: File) => {
    const filename = screenshotName(new Date(), ++shotSeq.current, file.type);
    setPending(m => new Map(m).set(filename, file));
    return { filename, previewUrl: URL.createObjectURL(file) };
  }, []);

  const nextTaskId = useCallback(() => String(++taskIdRef.current), []);

  // Uploads pasted screenshots; each one that went up leaves `pending`, so a retry
  // after a failure doesn't re-send it (Confluence rejects a duplicate name).
  async function uploadAll(pageId: string, filenames: string[]): Promise<string | null> {
    const { done, error } = await uploadEach(filenames.filter(f => pending.has(f)), async filename => {
      const file = pending.get(filename)!;
      const res = await api!.uploadAttachment({ ...creds, pageId, filename, mediaType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
      return res.ok ? null : (res.error ?? 'upload failed');
    });
    if (done.length) setPending(m => { const n = new Map(m); done.forEach(f => n.delete(f)); return n; });
    return error ? `Screenshot ${error}` : null;
  }

  // A new page shows the source page's screenshots by filename: copy them over.
  async function copyFromSource(pageId: string, filenames: string[]): Promise<string | null> {
    if (!sourcePageId || sourcePageId === pageId) return null;
    // Copy every one, reporting all failures — one bad file shouldn't stop the rest.
    const errors: string[] = [];
    for (const filename of filenames.filter(f => !pending.has(f))) {
      const got = await api!.fetchAttachment({ ...creds, pageId: sourcePageId, filename });
      if (!got.ok || !got.dataUri) { errors.push(`copy ${filename}: ${got.error ?? 'not found'}`); continue; }
      const [head, b64] = got.dataUri.split(',');
      const bytes = Uint8Array.from(atob(b64!), ch => ch.charCodeAt(0));
      const up = await api!.uploadAttachment({ ...creds, pageId, filename, mediaType: head!.slice(5).split(';')[0]!, bytes });
      if (!up.ok) errors.push(`copy ${filename}: ${up.error}`);
    }
    return errors.length ? errors.join('; ') : null;
  }

  const updateSection = useCallback((i: number, next: EditSection) => {
    setDoc(d => (d ? { ...d, sections: d.sections.map((s, j) => (j === i ? next : s)) } : d));
    setDirty(true);
  }, []);

  const times = useMemo(() => doc?.sections.map(s => rowSchedule(s)) ?? [], [doc]);
  const issueCount = times.flat().filter(t => t.issues.length).length;

  const anchorOptions = useMemo(() => {
    if (!doc) return [];
    return doc.sections.flatMap((s, si) => times[si]!.map((t, r) => ({ s, si, r, t })))
      .filter(({ t }) => t.startLabel)
      .map(({ s, si, r, t }) => {
        const c = colIndex(s, 'activity');
        const act = c >= 0 ? cellText(effectiveCell(s, r, c).inner).slice(0, 40) : '';
        return { value: `${si}:${r}`, label: `${s.heading} · ${t.startLabel} · ${act}` };
      });
  }, [doc, times]);

  function pickAnchor(value: string) {
    const [s, r] = value.split(':').map(Number);
    const t = times[s!]?.[r!];
    setAnchor({ section: s!, row: r! });
    if (t?.startAbs != null && t.date) {
      setStartDate(t.date);
      setStartTime(`${String(Math.floor((t.startAbs % 1440) / 60)).padStart(2, '0')}:${String(t.startAbs % 60).padStart(2, '0')}`);
    }
  }

  function applyShift() {
    if (!doc || !anchor || !startDate || !startTime) return;
    setDoc(shiftRunbook(doc, anchor, `${startDate}T${startTime}`));
    setTitle(t => shiftTitleDate(t, startDate));
    setDirty(true);
    toast.success('Runbook rescheduled', { description: 'Dates, times, planned times and logbook check times moved. Review, then save.' });
  }

  const finalDoc = useMemo(() => (doc ? applySchedule(doc).doc : null), [doc]);
  const changes = useMemo(() => (finalDoc && original ? diffRunbook(original, finalDoc) : null), [finalDoc, original]);
  const screenshotCounts = useMemo(() => {
    if (!finalDoc) return undefined;
    const names = referencedImages(serializeRunbookDoc(finalDoc));
    return { upload: names.filter(f => pending.has(f)).length, copy: target?.kind === 'new' && sourcePageId ? names.filter(f => !pending.has(f)).length : 0 };
  }, [finalDoc, pending, target, sourcePageId]);


  function openDialog(kind: Exclude<DialogKind, null>) {
    setDialogError(null);
    setConflict(null);
    setParentUrl('');
    setDialogTitle(kind === 'template' ? `${TEMPLATE_PREFIX}${title.replace(/^\[Template\]\s*/i, '')}` : title);
    setDialog(kind);
  }

  async function resolveParent(): Promise<{ spaceKey: string; parentId: string }> {
    if (parentUrl.trim()) {
      const p = await api?.getPage({ ...creds, pageUrl: parentUrl.trim() });
      if (!p?.ok) throw new Error(`Parent page: ${p?.error ?? 'not found'}`);
      return { spaceKey: p.spaceKey ?? '', parentId: p.pageId ?? '' };
    }
    if (target?.spaceKey && target.parentId) return { spaceKey: target.spaceKey, parentId: target.parentId };
    throw new Error('Paste the URL of the page to create it under.');
  }

  async function confirmDialog() {
    if (!finalDoc || !target || !api) return;
    setBusy(true);
    setDialogError(null);
    try {
      if (dialog === 'save' && target.kind === 'existing') {
        const storage = serializeRunbookDoc(finalDoc);
        const uploadErr = await uploadAll(target.pageId, referencedImages(storage).filter(f => pending.has(f)));
        if (uploadErr) { setDialogError(`${uploadErr} — the page was not saved.`); return; }
        const res = await api.updatePage({
          ...creds, pageId: target.pageId, title: title.trim(), storage, baseVersion: target.version,
        });
        if (res.conflict) {
          setConflict({ by: res.by ?? '', when: res.when ?? '', version: res.latestVersion });
          setDialogError(res.error ?? 'The page changed in Confluence.');
          return;
        }
        if (!res.ok) { setDialogError(res.error ?? 'Save failed.'); return; }
        toast.success(`Saved version ${res.version}`, { description: title });
        setDialog(null);
        setDirty(false);
        setPending(new Map());
        await loadExisting(target.url);
        return;
      }

      const { spaceKey, parentId } = await resolveParent();
      const asTemplate = dialog === 'template';
      const body = asTemplate ? applySchedule(resetForTemplate(finalDoc)).doc : finalDoc;
      const storage = serializeRunbookDoc(body);
      const res = await api.createPage({ ...creds, spaceKey, parentId, title: dialogTitle.trim(), storage });
      if (!res.ok) {
        setDialogError(res.duplicateTitle ? `A page titled “${dialogTitle.trim()}” already exists in ${spaceKey}. Pick another title.` : (res.error ?? 'Create failed.'));
        return;
      }
      setDialog(null);
      // The page exists now: bring its screenshots (copied from the source page, or pasted) along.
      const names = referencedImages(storage);
      // Run both steps whatever happens in the first, and report every failure.
      const fileErr = [await copyFromSource(res.pageId!, names), await uploadAll(res.pageId!, names)].filter(Boolean).join('; ');
      if (fileErr) toast.warning('Page created with a missing screenshot', { description: `${fileErr}. Open the page in Confluence to re-add it.`, duration: 15000 });
      if (asTemplate) {
        setTemplateHistory(pushUrlHistory(TEMPLATE_HIST_KEY, res.url ?? ''));
        toast.success('Template saved', { description: dialogTitle.trim() });
        return;
      }
      toast.success('Runbook created', { description: dialogTitle.trim() });
      setDirty(false);
      if (res.url) {
        setOpenUrl(res.url);
        await loadExisting(res.url);
      }
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function reloadAfterConflict() {
    if (target?.kind !== 'existing') return;
    setLostEdits(changes);
    setDialog(null);
    setDirty(false);
    await loadExisting(target.url);
  }

  const blocked = !hasCreds || conn.tokenDead;
  const titleChange = original && title.trim() !== originalTitle ? { before: originalTitle, after: title.trim() } : undefined;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={BookOpen}
        title="Release Runbook"
        subtitle="Create, template and edit Confluence deployment runbooks. Planned Start = Time, Planned End = Start + Duration — always."
        actions={confluenceBaseUrl ? <ConfluenceConnectionPills conn={conn} /> : undefined}
      />

      {!hasCreds && <ConfluenceCredsBanner />}
      {hasCreds && <TokenIssueBanner status={conn.tokenStatus} onRecheck={() => void conn.checkToken()} />}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!doc && (
        <div className="grid gap-3 lg:grid-cols-3">
          <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><BookOpen className="h-4 w-4" /> Edit a runbook</h2>
            <p className="text-xs text-muted-foreground">Open an existing runbook page to reschedule it or change its activities.</p>
            <Input list="re-runbook-urls" value={openUrl} onChange={e => setOpenUrl(e.target.value)} placeholder="Runbook page URL"
              className="text-xs font-mono" disabled={blocked || loading} onKeyDown={e => { if (e.key === 'Enter' && openUrl.trim()) void loadExisting(openUrl.trim()); }} />
            <datalist id="re-runbook-urls">{runbookHistory.map(u => <option key={u} value={u} />)}</datalist>
            <Button size="sm" className="self-start gap-1.5" disabled={blocked || loading || !openUrl.trim()} onClick={() => void loadExisting(openUrl.trim())}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <BookOpen className="h-4 w-4" />} Open
            </Button>
          </div>
          <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><FileStack className="h-4 w-4" /> New from template</h2>
            <p className="text-xs text-muted-foreground">Any runbook or template page. Statuses reset to TODO, logbooks are emptied (check-time drawers kept).</p>
            <Input list="re-template-urls" value={templateUrl} onChange={e => setTemplateUrl(e.target.value)} placeholder="Template or previous runbook URL"
              className="text-xs font-mono" disabled={blocked || loading} onKeyDown={e => { if (e.key === 'Enter') void newFromTemplate(); }} />
            <datalist id="re-template-urls">{templateHistory.map(u => <option key={u} value={u} />)}</datalist>
            <Button size="sm" className="self-start gap-1.5" disabled={blocked || loading || !templateUrl.trim()} onClick={() => void newFromTemplate()}>
              <FileStack className="h-4 w-4" /> Use template
            </Button>
          </div>
          <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><FilePlus2 className="h-4 w-4" /> New blank runbook</h2>
            <p className="text-xs text-muted-foreground">Pre-Prod, Prod, Post-Prod and Rollback plan sections with the standard columns.</p>
            <Button size="sm" variant="outline" className="mt-auto self-start gap-1.5" disabled={blocked} onClick={() => void newBlank()}>
              <FilePlus2 className="h-4 w-4" /> Start blank
            </Button>
          </div>
        </div>
      )}

      {doc && target && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 rounded-lg border bg-card px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input value={title} onChange={e => { setTitle(e.target.value); setDirty(true); }} className="h-8 min-w-[18rem] flex-1 text-sm font-semibold" aria-label="Page title" />
              {target.kind === 'existing' ? (
                <>
                  <span className="text-xs text-muted-foreground">Editing v{target.version}</span>
                  <a href={target.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-info hover:underline">
                    Open in Confluence <ExternalLink className="h-3 w-3" />
                  </a>
                </>
              ) : (
                <span className="text-xs text-muted-foreground">New page · from {target.from}</span>
              )}
              <Hint label="Create a template page from this runbook (statuses TODO, logbooks emptied)">
                <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={blocked} onClick={() => openDialog('template')}>
                  <FileStack className="h-3.5 w-3.5" /> Save as template…
                </Button>
              </Hint>
              {target.kind === 'existing' ? (
                <Button size="sm" className="h-8 gap-1.5" disabled={blocked || !title.trim()} onClick={() => openDialog('save')}>
                  <Save className="h-3.5 w-3.5" /> Review & save
                </Button>
              ) : (
                <Button size="sm" className="h-8 gap-1.5" disabled={blocked || !title.trim()} onClick={() => openDialog('create')}>
                  <FilePlus2 className="h-3.5 w-3.5" /> Create page…
                </Button>
              )}
              <Hint label="Close the editor">
                <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground" onClick={closeEditor}><X className="h-4 w-4" /></Button>
              </Hint>
            </div>

            <div className="flex flex-wrap items-end gap-2 border-t pt-3">
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">Deployment start (SGT)</span>
                <div className="flex gap-1.5">
                  <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="h-8 w-[9.5rem] text-xs" />
                  <Input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className="h-8 w-[7.5rem] text-xs" />
                </div>
              </div>
              <div className="flex min-w-[16rem] flex-1 flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">Starts with</span>
                <Select value={anchor ? `${anchor.section}:${anchor.row}` : ''} onValueChange={pickAnchor} disabled={!anchorOptions.length}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder={anchorOptions.length ? 'Pick the activity the deployment starts with' : 'Give an activity a Date and Time first'} />
                  </SelectTrigger>
                  <SelectContent>
                    {anchorOptions.map(o => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Hint label="Move every date, time, planned time and logbook check time so this activity starts at the new time">
                <Button size="sm" variant="secondary" className="h-8 gap-1.5" disabled={!anchor || !startDate || !startTime} onClick={applyShift}>
                  <CalendarClock className="h-3.5 w-3.5" /> Reschedule
                </Button>
              </Hint>
              {issueCount > 0 && (
                <span className="inline-flex items-center gap-1 text-xs text-warning">
                  <TriangleAlert className="h-3.5 w-3.5" /> {issueCount} row{issueCount === 1 ? '' : 's'} with an unreadable duration — no Planned End
                </span>
              )}
            </div>
          </div>

          {lostEdits && lostEdits.length > 0 && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs text-warning">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">Reloaded the latest version. Your earlier edits were not saved — redo them:</span>
                <button type="button" className="opacity-70 hover:opacity-100" aria-label="Dismiss" onClick={() => setLostEdits(null)}><X className="h-3.5 w-3.5" /></button>
              </div>
              <ul className="mt-1 list-disc pl-5">
                {lostEdits.map((c, i) => (
                  <li key={i}>{c.section} row {c.row} ({c.activity.slice(0, 50)}): {c.kind === 'changed' ? `${c.column} ${c.before || '—'} → ${c.after || '—'}` : c.kind}</li>
                ))}
              </ul>
            </div>
          )}

          {doc.sections.map((section, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <h2 className="text-sm font-semibold">{section.heading || 'Runbook'}</h2>
              <RunbookSectionTable
                section={section}
                times={times[i]!}
                names={names}
                anchorRow={anchor?.section === i ? anchor.row : null}
                onChange={next => updateSection(i, next)}
                searchUsers={searchUsers}
                onLearnName={learnName}
                onOpenRich={(r, c) => setRich({ section: i, row: r, col: c })}
              />
            </div>
          ))}
        </div>
      )}

      <AlertDialog open={pendingDiscard !== null} onOpenChange={o => { if (!o) setPendingDiscard(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your edits to “{title}” haven’t been saved to Confluence. They’ll be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { const run = pendingDiscard; setPendingDiscard(null); setDirty(false); run?.(); }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {doc && rich && (() => {
        const sec = doc.sections[rich.section]!;
        const col = sec.columns[rich.col]!;
        return (
          <RichTextPanel
            open
            heading={`${col.label} — ${sec.heading} row ${rich.row + 1}`}
            inner={effectiveCell(sec, rich.row, rich.col).inner}
            names={names}
            loadPreview={loadPreview}
            onAddImage={addImage}
            searchUsers={searchUsers}
            onLearnName={learnName}
            nextTaskId={nextTaskId}
            onApply={next => {
              // A merged cell is edited where it lives, keeping the merge.
              if (next !== null) updateSection(rich.section, setCell(sec, ownerRow(sec, rich.row, rich.col), rich.col, next));
              setRich(null);
            }}
            onClose={() => setRich(null)}
          />
        );
      })()}

      <SaveReviewDialog
        screenshots={screenshotCounts}
        open={dialog !== null}
        heading={dialog === 'save' ? 'Save to Confluence' : dialog === 'template' ? 'Save as template' : 'Create runbook page'}
        target={dialog === 'save' && target?.kind === 'existing'
          ? `Saves version ${target.version + 1} of “${title.trim()}”. Nothing is written until you confirm.`
          : 'Creates a new Confluence page. Nothing is written until you confirm.'}
        confirmLabel={dialog === 'save' ? 'Save' : 'Create page'}
        changes={dialog === 'save' ? changes : null}
        titleChange={dialog === 'save' ? titleChange : undefined}
        busy={busy}
        error={dialogError}
        canConfirm={dialog === 'save' || !!dialogTitle.trim()}
        onConfirm={() => void confirmDialog()}
        onClose={() => setDialog(null)}
      >
        {dialog !== 'save' && (
          <div className="flex flex-col gap-2 text-xs">
            <label className="flex flex-col gap-1">
              <span className="font-medium">Title</span>
              <Input value={dialogTitle} onChange={e => setDialogTitle(e.target.value)} className="h-8 text-xs" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-medium">Parent page URL</span>
              <Input value={parentUrl} onChange={e => setParentUrl(e.target.value)} className="h-8 font-mono text-xs"
                placeholder={target?.parentId ? 'Leave empty to use the same parent as the source page' : 'https://your-site.atlassian.net/wiki/spaces/SPACE/pages/123/Releases'} />
            </label>
          </div>
        )}
        {conflict && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            <span>
              {conflict.by || 'Someone'} saved version {conflict.version ?? '?'}{conflict.when ? ` at ${new Date(conflict.when).toLocaleString()}` : ''}. devForge never overwrites it.
            </span>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void reloadAfterConflict()}>Reload latest</Button>
            {target?.kind === 'existing' && (
              <a href={target.url} target="_blank" rel="noopener noreferrer" className="text-info hover:underline">Open in Confluence</a>
            )}
          </div>
        )}
      </SaveReviewDialog>
    </div>
  );
}
