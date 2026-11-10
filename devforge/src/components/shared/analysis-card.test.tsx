import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AnalysisCard } from './analysis-card';

const render = (props: { open?: boolean; showBody?: boolean; children?: React.ReactNode } = {}) => renderToStaticMarkup(
  <TooltipProvider>
    <AnalysisCard
      state={{ status: 'done', markdown: '## Summary', error: null }}
      heading="Investigation report"
      icon={null}
      open={props.open ?? true}
      onToggle={() => {}}
      onRetry={() => {}}
      retryHint=""
      runningLabel=""
      writingLabel=""
      tabs={<span>TABS</span>}
      footer={<span>FOOTER</span>}
      {...(props.showBody !== undefined ? { showBody: props.showBody } : {})}
    >
      {props.children}
    </AnalysisCard>
  </TooltipProvider>,
);

describe('AnalysisCard tabs', () => {
  it('shows the tabs above the report', () => {
    const html = render();
    expect(html.indexOf('TABS')).toBeGreaterThan(-1);
    expect(html.indexOf('TABS')).toBeLessThan(html.indexOf('Summary'));
    expect(html).toContain('FOOTER');
  });

  it('hides the report and footer when another tab shows', () => {
    const html = render({ showBody: false, children: <span>FORM</span> });
    expect(html).not.toContain('Summary');
    expect(html).not.toContain('FOOTER');
    expect(html).toContain('FORM');
  });

  it('keeps children mounted but hidden while collapsed', () => {
    const html = render({ open: false, children: <span>FORM</span> });
    expect(html).toContain('FORM');
    expect(html).toMatch(/class="[^"]*\bhidden\b[^"]*"/);
  });

  it('renders no body at all when collapsed without children', () => {
    expect(render({ open: false })).not.toContain('TABS');
  });
});
