import { useEffect, useRef, useState } from 'react';
import { Share2, FileText, FileType2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { Textarea } from '@/components/ui/textarea';
import { RichTextField } from './richTextField';
import { Input } from '@/components/ui/input';
import {
  parseRcaFields, parseTrackerFields, composeRcaMarkdown, isRcaFieldsEmpty, stripMarkdown,
  htmlToPlainText, plainTextToHtml, trackerCopyText,
  EMPTY_RCA_FIELDS, EMPTY_TRACKER_FIELDS, TRACKER_FIELDS,
  RCA_SECTIONS, RCA_META_FIELDS,
  type RcaFields, type RcaTrackerFields,
} from './rcaHtml';
import { RCA_STYLES } from './rcaDialog';
import { UI } from '@/lib/chart-colors';
import { CopyButton } from '@/components/toolbox/toolbox-shared';

interface RcaSectionProps {
  /** An RCA in the report layout to fill blank fields from; '' when there is none yet. */
  markdown: string;
  /** The form as markdown — what the exports and the Teams copy send. */
  onDraftChange: (markdown: string) => void;
  /** Prefills the metadata the host already knows. */
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
  /** The report form or the Tracker, for a host that puts them in tabs. One mounted
   *  instance serves both tabs, so edits survive switching between them. */
  view: 'rca' | 'tracker';
}

/** The RCA as an editable form plus its Tracker: an engineer fills what only they know,
 *  and a finished investigation fills the rest, leaving anything already typed alone. */
export function RcaSection({
  markdown, onDraftChange, defaultServices, defaultTitle, period = '', periodSource = 'none',
  onExportPdf, onExportWord, onCopyTeams, view,
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
  const [trackerFields, setTrackerFields] = useState<RcaTrackerFields>({ ...EMPTY_TRACKER_FIELDS });
  const setTrackerField = (key: keyof RcaTrackerFields, value: string) =>
    setTrackerFields(prev => ({ ...prev, [key]: value }));

  // An RCA fills only the fields left blank, so nothing typed here is ever overwritten.
  // Guarded by a ref: the effect must run once per report, not on every keystroke after.
  const filledFrom = useRef<string | null>(null);
  useEffect(() => {
    if (!markdown || filledFrom.current === markdown) return;
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
  }, [markdown]);

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

  // The draft feeds PDF, Word and Copy for Teams, so it carries the RCA only, not the Tracker.
  const draft = composeRcaMarkdown(fields);
  const draftRef = useRef('');
  useEffect(() => {
    if (draftRef.current === draft) return;
    draftRef.current = draft;
    onDraftChange(draft);
    // onDraftChange is a fresh closure each render; the draft guard above is what
    // keeps this from looping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // Tracker text alone gives the exports nothing to write, so it does not enable them.
  const hasContent = !isRcaFieldsEmpty(fields);

  return (
    <div className="px-4 pb-3">
      {view === 'rca' ? (
        // The report as one card: metadata, sections and exports separated by rules.
        <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/10 p-3">
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
      ) : (
        // Tracker — the QA-style record that travels with the report: what was seen,
        // what it turned out to be, what was done, what proved it worked.
        <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/10 p-3">
          {/* Two per row, with the odd last field spanning the width. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {TRACKER_FIELDS.map((f, i) => (
              // A div, not a label: a label would hand clicks on its text to the copy button.
              <div
                key={f.key}
                className={`flex flex-col gap-1${i === TRACKER_FIELDS.length - 1 && TRACKER_FIELDS.length % 2 === 1 ? ' sm:col-span-2' : ''}`}
              >
                <span className="flex h-5 items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {f.label}
                  <span data-html2canvas-ignore="true"><CopyButton value={trackerFields[f.key]} label={`Copy ${f.label}`} /></span>
                </span>
                <Textarea
                  value={trackerFields[f.key]}
                  onChange={e => setTrackerField(f.key, e.target.value)}
                  placeholder={f.hint}
                  aria-label={f.label}
                  className="min-h-[56px] resize-y text-xs leading-relaxed"
                  spellCheck={false}
                />
              </div>
            ))}
          </div>
          <div className="flex justify-end" data-html2canvas-ignore="true">
            <CopyButton value={trackerCopyText(trackerFields)} label="Copy every filled Tracker field, one per line" text="Copy all" />
          </div>
        </div>
      )}
      <style>{RCA_STYLES}</style>
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
