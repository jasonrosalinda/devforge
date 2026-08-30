import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import { Loader2, Share2, AlertTriangle, ScanSearch, Check, FileText, FileType2, Sparkles, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { Textarea } from '@/components/ui/textarea';
import { RichTextField } from './richTextField';
import { Input } from '@/components/ui/input';
import {
  splitQuickSummary, parseRcaFields, parseTrackerFields, composeRcaMarkdown, isRcaFieldsEmpty, stripMarkdown,
  htmlToPlainText, plainTextToHtml, isTrackerEmpty,
  EMPTY_RCA_FIELDS, EMPTY_TRACKER_FIELDS, TRACKER_FIELDS,
  RCA_SECTIONS, RCA_META_FIELDS,
  type RcaFields, type RcaTrackerFields,
} from './rcaHtml';
import { RCA_STYLES, type RcaStatus } from './rcaDialog';
import { UI } from '@/lib/chart-colors';

interface RcaSectionProps {
  open: boolean;
  onToggle: () => void;
  status: RcaStatus;
  markdown: string;
  stages: string[];
  error: string | null;
  /** Runs the analysis, handing the engineer's own section text over as evidence and
   *  the header facts over as values the model must reproduce verbatim. */
  onGenerate: (
    investigationNotes: string,
    given: {
      incidentName?: string;
      incidentPeriod?: string;
      servicesAffected?: string;
      reportTitle?: string;
    },
  ) => void;
  /** The form as markdown — what the exports and the Teams copy send. */
  onDraftChange: (markdown: string) => void;
  /** Prefills the metadata a card already knows. */
  defaultServices?: string;
  /** Default report title and incident name, e.g. "MIMS CPD Downtime". */
  defaultTitle?: string;
  /** The outage window itself — first downtime start → last downtime end. Read-only:
   *  it is measured, not written. */
  period?: string;
  periodSource?: 'uptimerobot' | 'azure' | 'none';
  onExportPdf: () => void;
  onExportWord: () => void;
  onCopyTeams: () => void;
  onCopySummary: () => void;
}

/** The report is a form from the start: an engineer fills what only they know —
 *  who reported it, what was changed — and the AI fills the rest from telemetry,
 *  leaving anything already typed alone. */
export function RcaSection({
  open, onToggle, status, markdown, stages, error,
  onGenerate, onDraftChange, defaultServices, defaultTitle, period = '', periodSource = 'none',
  onExportPdf, onExportWord, onCopyTeams, onCopySummary,
}: RcaSectionProps) {
  const [fields, setFields] = useState<RcaFields>({
    ...EMPTY_RCA_FIELDS,
    title: defaultTitle ?? '',
    incident: defaultTitle ?? '',
    services: defaultServices ?? '',
    severity: DEFAULT_SEVERITY,
    period,
  });
  const set = (key: keyof RcaFields, value: string) => setFields(prev => ({ ...prev, [key]: value }));
  const [formOpen, setFormOpen] = useState(true);
  // The record the report hands over, kept beside it rather than inside a section.
  const [trackerFields, setTrackerFields] = useState<RcaTrackerFields>({ ...EMPTY_TRACKER_FIELDS });
  const [trackerOpen, setTrackerOpen] = useState(false);

  const setTrackerField = (key: keyof RcaTrackerFields, value: string) =>
    setTrackerFields(prev => ({ ...prev, [key]: value }));

  const { summary } = status === 'done' ? splitQuickSummary(markdown) : { summary: '' };
  const summaryHtml = summary ? (marked.parse(summary, { async: false }) as string) : '';

  // A finished run fills only the fields left blank, so nothing typed here is ever
  // overwritten by the model. Guarded by a ref: the effect must run once per run,
  // not on every keystroke that follows it.
  const filledFrom = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 'done' || !markdown || filledFrom.current === markdown) return;
    filledFrom.current = markdown;
    const parsed = parseRcaFields(markdown);
    const sectionKeys = RCA_SECTIONS.map(sec => sec.key) as Array<keyof RcaFields>;
    setFields(prev => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(parsed) as Array<[keyof RcaFields, string]>) {
        // The period is measured downtime — the model's version never replaces it.
        if (k === 'period') continue;
        const plain = stripMarkdown(v ?? '');
        if (!plain) continue;
        const isSection = sectionKeys.includes(k);
        const filled = isSection ? htmlToPlainText(next[k] ?? '').trim() : (next[k] ?? '').trim();
        if (filled) continue;
        next[k] = isSection ? plainTextToHtml(plain) : plain;
      }
      return next;
    });
    // Same rule for the tracker: a generated value fills a blank field and never replaces
    // something the engineer already wrote.
    const parsedTracker = parseTrackerFields(markdown);
    setTrackerFields(prev => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(parsedTracker) as Array<[keyof RcaTrackerFields, string]>) {
        const plain = stripMarkdown(v ?? '').trim();
        // 'not established' is the model saying it could not answer. Leaving the field blank
        // keeps it visibly unanswered rather than filling it with that phrase.
        if (!plain || /^not established\.?$/i.test(plain)) continue;
        if ((next[k] ?? '').trim()) continue;
        next[k] = plain;
      }
      return next;
    });
  }, [status, markdown]);

  // Title, incident and services are prefills the engineer may edit; the period is
  // not editable at all, so it always tracks the measured downtime.
  useEffect(() => {
    setFields(prev => ({
      ...prev,
      title:    prev.title    || (defaultTitle    ?? ''),
      incident: prev.incident || (defaultTitle    ?? ''),
      services: prev.services || (defaultServices ?? ''),
      severity: prev.severity || DEFAULT_SEVERITY,
      period,
    }));
  }, [defaultTitle, defaultServices, period]);

  const trackerFilled = !isTrackerEmpty(trackerFields);
  const draft = composeRcaMarkdown(fields, summary, trackerFields);
  const draftRef = useRef('');
  useEffect(() => {
    if (draftRef.current === draft) return;
    draftRef.current = draft;
    onDraftChange(draft);
    // onDraftChange is a fresh closure each render; the draft guard above is what
    // keeps this from looping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const hasContent = !isRcaFieldsEmpty(fields) || trackerFilled;

  /** What the engineer wrote goes to the model as evidence; the header facts go as
   *  values it must reproduce, so its report matches this form. */
  const handleGenerate = () => {
    const written = RCA_SECTIONS
      .filter(s => fields[s.key].trim())
      .map(s => `### ${s.n}. ${s.label}\n${fields[s.key].trim()}`);
    const notes = RCA_META_FIELDS
      .filter(f => !['period', 'services', 'incidentNumber'].includes(f.key) && fields[f.key].trim())
      .map(f => `${f.mdLabel}: ${fields[f.key].trim()}`);
    // The tracker goes too. It is the engineer's own record, so whatever is already written
    // is sent as text the model must reproduce rather than re-word — it only drafts blanks.
    const tracked = TRACKER_FIELDS
      .filter(f => trackerFields[f.key].trim())
      .map(f => `${f.label}: ${trackerFields[f.key].trim()}`);
    const trackerNote = tracked.length
      ? ['### Tracker — already recorded by the analyst, reproduce these exactly', ...tracked].join('\n')
      : '';
    const title = fields.title.trim() || defaultTitle || '';
    onGenerate([...notes, ...written, ...(trackerNote ? [trackerNote] : [])].join('\n\n'), {
      ...(fields.period.trim()   ? { incidentPeriod:   fields.period.trim() }   : {}),
      ...(fields.services.trim() ? { servicesAffected: fields.services.trim() } : {}),
      ...(title                  ? { reportTitle:      title }                  : {}),
    });
  };

  return (
    <div className="px-4 pb-3">
      <div className="rounded-md border border-border overflow-hidden">
        <div
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-muted-foreground cursor-pointer"
          onClick={onToggle}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          title={open ? 'Collapse Root Cause Analysis Generator' : 'Expand Root Cause Analysis Generator'}
        >
          <ScanSearch className="h-3.5 w-3.5" style={{ color: UI.info }} />
          <span>Root Cause Analysis Generator</span>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <button
            onClick={e => { e.stopPropagation(); handleGenerate(); }}
            disabled={status === 'running'}
            className="ml-auto p-0.5 rounded hover:bg-muted flex-shrink-0 disabled:opacity-50"
            title={status === 'running'
              ? 'Generating AI RCA…'
              : 'Generate AI RCA (Claude root-cause analysis — anything you have typed is used as evidence and kept)'}
            data-html2canvas-ignore="true"
          >
            <Sparkles
              className="w-3.5 h-3.5"
              style={status === 'running' ? {
                color: UI.info,
                filter: `drop-shadow(0 0 6px ${UI.info})`,
                animation: 'sparkle-glow 1.2s ease-in-out infinite',
              } : undefined}
            />
          </button>
        </div>

        {open && (
          <div className="border-t border-border px-3 py-2.5 flex flex-col gap-3">
            {status === 'error' && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-xs leading-relaxed text-destructive">{error || 'Something went wrong.'}</p>
              </div>
            )}

            {status === 'running' && (
              <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/20 p-2.5">
                {stages.length === 0 && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Starting…
                  </div>
                )}
                {stages.map((s, i) => {
                  // Last stage is in progress until Claude output starts streaming.
                  const active = i === stages.length - 1 && !markdown;
                  return (
                    <div key={i} className="flex items-start gap-2 text-xs leading-relaxed">
                      {active
                        ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-info" />
                        : <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />}
                      <span className={active ? 'text-foreground' : 'text-muted-foreground'}>{s}</span>
                    </div>
                  );
                })}
                {markdown && (
                  <pre className="mt-1 max-h-[220px] overflow-y-auto whitespace-pre-wrap border-t border-border pt-2 font-mono text-[11px] leading-relaxed text-foreground/80">
                    {markdown}
                  </pre>
                )}
              </div>
            )}

            {summaryHtml && (
              <div className="rca-summary">
                <div className="rca-summary-label">
                  <ScanSearch className="h-3.5 w-3.5" />
                  <span>Quick Summary</span>
                  <button
                    type="button"
                    className="rca-summary-copy"
                    onClick={onCopySummary}
                    title="Copy the Quick Summary formatted for Microsoft Teams"
                    data-html2canvas-ignore="true"
                  >
                    <Share2 className="h-3 w-3" />
                    Copy for Teams
                  </button>
                </div>
                <div dangerouslySetInnerHTML={{ __html: summaryHtml }} />
              </div>
            )}

            {/* The report as one card: metadata, sections and exports separated by
                rules rather than by a box around each part. It folds on its own so a
                finished report can be put away without collapsing the whole section,
                which would also hide the Quick Summary. */}
            <div className="flex flex-col rounded-md border border-border bg-muted/10">
              <div
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground cursor-pointer"
                onClick={() => setFormOpen(v => !v)}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                title={formOpen ? 'Collapse the report' : 'Expand the report'}
              >
                <span>Report</span>
                {formOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                {!formOpen && (
                  <span className="ml-auto truncate font-normal text-[10px]" title={fields.title}>
                    {fields.title || 'untitled'}
                  </span>
                )}
              </div>
            {formOpen && (
            <div className="flex flex-col gap-3 border-t border-border p-3">
            {/* Title + metadata */}
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  RCA Report title
                </span>
                <Input
                  value={fields.title}
                  onChange={e => set('title', e.target.value)}
                  placeholder={defaultTitle || 'MIMS CPD Downtime'}
                  className="h-7 text-xs"
                />
              </label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {RCA_META_FIELDS.map(f => {
                  // Incident Period is measured, not written: first downtime start →
                  // last downtime end, from UptimeRobot where a monitor exists.
                  const readOnly = f.key === 'period';
                  return (
                    <label key={f.key} className="flex flex-col gap-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {f.label}
                        {readOnly && (
                          <span className="ml-1 font-normal normal-case tracking-normal text-[9px]" style={{ color: UI.textMuted }}>
                            · {PERIOD_SOURCE_LABEL[periodSource]}
                          </span>
                        )}
                      </span>
                      <Input
                        value={fields[f.key]}
                        onChange={readOnly ? undefined : e => set(f.key, e.target.value)}
                        readOnly={readOnly}
                        tabIndex={readOnly ? -1 : undefined}
                        aria-readonly={readOnly || undefined}
                        placeholder={readOnly
                          ? PERIOD_EMPTY_PLACEHOLDER[periodSource]
                          : f.key === 'incident'
                            ? (defaultTitle || META_PLACEHOLDER.incident)
                            : META_PLACEHOLDER[f.key]}
                        title={readOnly ? PERIOD_TITLE[periodSource] : undefined}
                        className={`h-7 text-xs${readOnly ? ' cursor-default bg-muted/40 text-muted-foreground focus-visible:ring-0' : ''}`}
                      />
                    </label>
                  );
                })}
              </div>
            </div>

            {/* The seven sections. Two per row — 1|2, 3|4, 5|6 — with the odd last
                section spanning the width rather than sitting in a half-empty row. */}
            <div className="grid grid-cols-1 gap-3 border-t border-border pt-3 sm:grid-cols-2">
              {RCA_SECTIONS.map((s, i) => (
                <div
                  key={s.key}
                  className={`flex flex-col gap-1${i === RCA_SECTIONS.length - 1 && RCA_SECTIONS.length % 2 === 1 ? ' sm:col-span-2' : ''}`}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {s.n}. {s.label}
                  </span>
                  <RichTextField
                    value={fields[s.key]}
                    onChange={html => set(s.key, html)}
                    placeholder={s.hint}
                    variant="flat"
                  />
                </div>
              ))}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border pt-3" data-html2canvas-ignore="true">
              <Hint label="Save this RCA as a PDF">
                <Button variant="outline" size="sm" disabled={!hasContent} onClick={onExportPdf}>
                  <FileText className="mr-1.5 h-3.5 w-3.5" /> PDF
                </Button>
              </Hint>
              <Hint label="Save this RCA as a Word document you can edit">
                <Button variant="outline" size="sm" disabled={!hasContent} onClick={onExportWord}>
                  <FileType2 className="mr-1.5 h-3.5 w-3.5" /> Word
                </Button>
              </Hint>
              <Hint label="Copy the RCA as rich text, ready to paste into Teams">
                <Button variant="default" size="sm" disabled={!hasContent} onClick={onCopyTeams}>
                  <Share2 className="mr-1.5 h-3.5 w-3.5" /> Copy for Teams
                </Button>
              </Hint>
            </div>
            </div>
            )}
            </div>

            {/* Tracker — the QA-style record that travels with the report: what was
                seen, what it turned out to be, what was done, what proved it worked. */}
            <div className="flex flex-col rounded-md border border-border bg-muted/10">
              <div
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground cursor-pointer"
                onClick={() => setTrackerOpen(v => !v)}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                title={trackerOpen ? 'Collapse Tracker' : 'Expand Tracker'}
              >
                <span>Tracker</span>
                {trackerOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                <span className="ml-auto font-normal text-[10px]">
                  {trackerFilled ? 'filled in' : 'nothing tracked'}
                </span>
              </div>

              {trackerOpen && (
                <div className="flex flex-col gap-3 border-t border-border p-3">
                  {/* Two per row, with the odd last field spanning the width. */}
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {TRACKER_FIELDS.map((f, i) => (
                      <label
                        key={f.key}
                        className={`flex flex-col gap-1${i === TRACKER_FIELDS.length - 1 && TRACKER_FIELDS.length % 2 === 1 ? ' sm:col-span-2' : ''}`}
                      >
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {f.label}
                        </span>
                        <Textarea
                          value={trackerFields[f.key]}
                          onChange={e => setTrackerField(f.key, e.target.value)}
                          placeholder={f.hint}
                          className="min-h-[56px] resize-y text-xs leading-relaxed"
                          spellCheck={false}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <style>{RCA_STYLES}</style>
          </div>
        )}
      </div>
    </div>
  );
}

const META_PLACEHOLDER: Record<(typeof RCA_META_FIELDS)[number]['key'], string> = {
  incidentNumber: 'INC-202607-001 — assigned automatically when the AI runs',
  incident:       'MIMS CPD Downtime',
  services:       'mims-cpd.com',
  period:         '',
  severity:       'High',
};

/** A downtime RCA is a High by default; the engineer downgrades it if it was not. */
const DEFAULT_SEVERITY = 'High';

type PeriodSource = 'uptimerobot' | 'azure' | 'none';

const PERIOD_SOURCE_LABEL: Record<PeriodSource, string> = {
  uptimerobot: 'from UptimeRobot downtime',
  azure:       'from Azure-detected downtime',
  none:        'no downtime detected',
};

const PERIOD_EMPTY_PLACEHOLDER: Record<PeriodSource, string> = {
  uptimerobot: '',
  azure:       '',
  none:        'No downtime in the selected window',
};

const PERIOD_TITLE: Record<PeriodSource, string> = {
  uptimerobot: 'First downtime start → last downtime end, as recorded by UptimeRobot (external monitoring). Measured, so not editable.',
  azure:       'First downtime start → last downtime end, from Azure availability. No UptimeRobot monitor is configured for this app, so this is the fallback. Measured, so not editable.',
  none:        'Neither UptimeRobot nor Azure recorded downtime in the selected window.',
};
