import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { StoryAction, StoryLine, StoryTone } from './remarkStory';

const ICON: Record<StoryTone, { Icon: typeof Info; cls: string }> = {
  ok: { Icon: CheckCircle2, cls: 'text-success' },
  info: { Icon: Info, cls: 'text-info' },
  warning: { Icon: AlertTriangle, cls: 'text-warning' },
  critical: { Icon: XCircle, cls: 'text-error' },
};

/** The remark story: one line per finding, in the order things happened, each with the
 *  action that explains it (the 5xx requests, the release verdict) one click away. */
export function RemarkStoryView({ lines, onAction }: { lines: StoryLine[]; onAction: (a: StoryAction) => void }) {
  return (
    <ul className="flex flex-col gap-1.5 text-xs">
      {lines.map((l, i) => {
        const { Icon, cls } = ICON[l.tone];
        return (
          <li key={i} className="flex items-start gap-2">
            <Icon className={cn('mt-px size-3.5 shrink-0', cls)} aria-label={l.tone} />
            <span className={cn('leading-snug', i === 0 && 'font-semibold', l.tone === 'critical' && i === 0 && 'text-error')}>
              {l.text}
              {l.actions.map((a, j) => (
                <button
                  key={j}
                  type="button"
                  onClick={() => onAction(a)}
                  className="ml-2 whitespace-nowrap text-info underline decoration-dotted underline-offset-2 hover:text-foreground"
                  data-html2canvas-ignore="true"
                >
                  {a.label}
                </button>
              ))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
