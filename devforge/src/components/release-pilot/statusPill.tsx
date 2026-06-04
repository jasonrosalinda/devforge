// Shared status pill — Confluence lozenge colours mapped to themed classes.
import type { StatusColor } from '@/lib/parse-runbook';

export const STATUS_CLASS: Record<StatusColor, string> = {
  green:  'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  yellow: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  red:    'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30',
  blue:   'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30',
  purple: 'bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/30',
  grey:   'bg-muted text-muted-foreground border-border',
};

export function StatusPill({ text, color }: { text: string; color: StatusColor }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${STATUS_CLASS[color]}`}>
      {text}
    </span>
  );
}
