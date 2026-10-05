// React node views for the Confluence chips in the rich text editor.

import { useEffect, useState } from 'react';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { Check, ImageOff, Loader2, Puzzle } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { CfImage, CfMention, CfRaw, CfRawBlock, CfStatus } from '@/lib/runbook-richtext/schema';
import { STATUS_CLASS } from '@/components/release-pilot/statusPill';
import type { StatusColor } from '@/lib/parse-runbook';

export interface ChipContext {
  names: Map<string, string>;
  loadPreview: (filename: string) => Promise<string | null>;
}

const COLOUR: Record<string, StatusColor> = { Grey: 'grey', Blue: 'blue', Green: 'green', Red: 'red', Yellow: 'yellow', Purple: 'purple' };

function MentionView({ node, extension }: ReactNodeViewProps) {
  const name = (extension.options as ChipContext).names.get(String(node.attrs.accountId)) ?? 'Unknown user';
  return <NodeViewWrapper as="span" className="mx-0.5 rounded bg-info/15 px-1 text-info">@{name}</NodeViewWrapper>;
}

// The six colours Confluence's storage format accepts for a status lozenge.
const STATUS_COLOURS = ['Grey', 'Blue', 'Green', 'Yellow', 'Red', 'Purple'] as const;

// Set just before the toolbar inserts a badge, so that badge opens its editor.
let openNextStatus = false;
export function requestStatusEditor() { openNextStatus = true; }

function StatusView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const [open, setOpen] = useState(false);
  // Consumed in an effect, not the state initializer: React's dev mode runs
  // initializers twice, and the second run would find the flag already cleared.
  useEffect(() => {
    if (!openNextStatus) return;
    openNextStatus = false;
    setOpen(true);
  }, []);
  const title = String(node.attrs.title);
  const colour = String(node.attrs.colour) || 'Grey';
  // An edited badge is rebuilt from title + colour on save (its original XHTML no longer applies).
  const set = (attrs: { title?: string; colour?: string }) => updateAttributes({ ...attrs, xml: '' });
  return (
    <NodeViewWrapper as="span" className="mx-0.5 inline-flex align-baseline">
      <Popover open={open} onOpenChange={o => { setOpen(o); if (!o) editor.commands.focus(); }}>
        <PopoverTrigger asChild>
          <button type="button" contentEditable={false} title="Edit status"
            className={`inline-flex rounded border px-1.5 text-[10px] font-semibold uppercase leading-4 ${STATUS_CLASS[COLOUR[colour] ?? 'grey']}`}>
            {title || 'Status'}
          </button>
        </PopoverTrigger>
        {/* Portal into the side panel itself: rendered from a node view, the popover isn't
            seen as nested in the panel, whose modal focus trap would steal its focus and clicks. */}
        <PopoverContent align="start" className="w-56 space-y-2 p-2" container={editor.view.dom.closest<HTMLElement>('[role="dialog"]')}>
          <Input autoFocus value={title} placeholder="Status text" className="h-8 text-xs uppercase"
            onChange={e => set({ title: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); setOpen(false); } }} />
          <div className="flex gap-1.5" role="radiogroup" aria-label="Status colour">
            {STATUS_COLOURS.map(k => (
              <button key={k} type="button" role="radio" aria-checked={k === colour} aria-label={k} title={k}
                onClick={() => set({ colour: k })}
                className={`flex h-6 w-6 items-center justify-center rounded border ${STATUS_CLASS[COLOUR[k] ?? 'grey']} ${k === colour ? 'ring-2 ring-ring ring-offset-1 ring-offset-popover' : ''}`}>
                {k === colour && <Check className="h-3.5 w-3.5" />}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </NodeViewWrapper>
  );
}

function RawView({ node }: ReactNodeViewProps) {
  return (
    <NodeViewWrapper as={node.type.name === 'cfRawBlock' ? 'div' : 'span'} title="Kept as it is — edit in Confluence"
      className="mx-0.5 inline-flex items-center gap-1 rounded border border-dashed px-1.5 text-[11px] text-muted-foreground">
      <Puzzle className="h-3 w-3" /> {String(node.attrs.label) || 'Confluence content'}
    </NodeViewWrapper>
  );
}

function ImageView({ node, extension, selected }: ReactNodeViewProps) {
  const { loadPreview } = extension.options as ChipContext;
  const filename = String(node.attrs.filename);
  const [src, setSrc] = useState<string | null>(String(node.attrs.previewUrl) || null);
  const [state, setState] = useState<'loading' | 'ok' | 'missing'>(src ? 'ok' : 'loading');
  useEffect(() => {
    if (src) return;
    let live = true;
    loadPreview(filename).then(u => { if (!live) return; setSrc(u); setState(u ? 'ok' : 'missing'); });
    return () => { live = false; };
  }, [filename, src, loadPreview]);
  return (
    <NodeViewWrapper className={`my-2 inline-flex flex-col gap-1 rounded border p-1 ${selected ? 'ring-2 ring-ring' : ''}`}>
      {state === 'loading' && <span className="flex h-24 w-40 items-center justify-center text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></span>}
      {state === 'missing' && <span className="flex h-24 w-40 items-center justify-center gap-1 text-xs text-muted-foreground"><ImageOff className="h-4 w-4" /> not found</span>}
      {state === 'ok' && src && <img src={src} alt={filename} className="max-h-60 max-w-full rounded" />}
      <span className="px-1 text-[10px] text-muted-foreground">{filename}</span>
    </NodeViewWrapper>
  );
}

/** The schema chips with React views; `ctx` reaches the views through extension options. */
export function chipViews(ctx: ChipContext) {
  return [
    CfMention.extend({ addOptions: () => ctx, addNodeView: () => ReactNodeViewRenderer(MentionView) }),
    CfStatus.extend({ addOptions: () => ctx, addNodeView: () => ReactNodeViewRenderer(StatusView) }),
    CfRaw.extend({ addOptions: () => ctx, addNodeView: () => ReactNodeViewRenderer(RawView) }),
    CfRawBlock.extend({ addOptions: () => ctx, addNodeView: () => ReactNodeViewRenderer(RawView) }),
    CfImage.extend({ addOptions: () => ctx, addNodeView: () => ReactNodeViewRenderer(ImageView) }),
  ];
}
