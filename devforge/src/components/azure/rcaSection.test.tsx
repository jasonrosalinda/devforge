import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RcaSection } from './rcaSection';

const render = (view: 'rca' | 'tracker') => renderToStaticMarkup(
  <TooltipProvider>
    <RcaSection
      markdown=""
      onDraftChange={() => {}}
      onExportPdf={() => {}}
      onExportWord={() => {}}
      onCopyTeams={() => {}}
      view={view}
    />
  </TooltipProvider>,
);

describe('RcaSection view', () => {
  it('shows only the report form, with its exports, for the RCA tab', () => {
    const html = render('rca');
    expect(html).toContain('RCA Report title');
    expect(html).toContain('Copy for Teams');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Root Cause Analysis Generator');
  });

  it('shows only the Tracker, with per-field and Copy all buttons, for the Tracker tab', () => {
    const html = render('tracker');
    expect(html).not.toContain('RCA Report title');
    expect(html).toContain('<textarea');
    expect(html).toContain('Copy all');
  });
});
