// Shared status pill — Confluence lozenge colours mapped to themed classes.
import type { StatusColor } from '@/lib/parse-runbook';

export const STATUS_CLASS: Record<StatusColor, string> = {
  green:  'bg-success/15 text-success border-success/30',
  yellow: 'bg-warning/15 text-warning border-warning/30',
  red:    'bg-error/15 text-error border-error/30',
  blue:   'bg-info/15 text-info border-info/30',
  purple: 'bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/30',
  grey:   'bg-muted text-muted-foreground border-border',
};

export function StatusPill({ text, color, preserveCase = false }: { text: string; color: StatusColor; preserveCase?: boolean }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold tracking-wide ${preserveCase ? '' : 'uppercase'} ${STATUS_CLASS[color]}`}>
      {text}
    </span>
  );
}
