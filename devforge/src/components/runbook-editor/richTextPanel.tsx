// Side panel that edits one Activity / Logbook cell as rich text. Apply hands the
// new storage XHTML back (or null when nothing changed); saving to Confluence
// stays with the page's Review & save.

import { useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import {
  Bold, Code, Tag, TriangleAlert, Columns3, Image as ImageIcon, Italic, Link2, List, ListChecks, ListOrdered, PanelBottomOpen, Rows3, Table as TableIcon, Trash2, UserRound,
} from 'lucide-react';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Hint } from '@/components/ui/hint';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { richTextSchema } from '@/lib/runbook-richtext/schema';
import { storageToEditorHtml } from '@/lib/runbook-richtext/storage-to-editor';
import { editorJsonToStorage } from '@/lib/runbook-richtext/editor-to-storage';
import { cellAfterEdit, pastedImages, unsupportedFormatting } from '@/lib/runbook-richtext/attachments';
import { chipViews, requestStatusEditor, type ChipContext } from './richTextNodeViews';

interface RichTextPanelProps extends ChipContext {
  open: boolean;
  heading: string;
  inner: string;
  onAddImage: (file: File) => { filename: string; previewUrl: string };
  searchUsers: (q: string) => Promise<{ accountId: string; displayName: string }[]>;
  onLearnName: (id: string, name: string) => void;
  nextTaskId: () => string;
  onApply: (inner: string | null) => void;
  onClose: () => void;
}

const CHIP_NAMES = new Set(['cfMention', 'cfStatus', 'cfRaw', 'cfRawBlock', 'cfImage']);

export function RichTextPanel(props: RichTextPanelProps) {
  // Remount per cell so the editor always starts from that cell's content.
  return (
    <Sheet open={props.open} onOpenChange={o => { if (!o) props.onClose(); }}>
      <SheetContent side="right" className="flex w-[min(960px,96vw)] flex-col gap-3 sm:max-w-none">
        {props.open && <PanelBody key={props.heading + props.inner} {...props} />}
      </SheetContent>
    </Sheet>
  );
}

function PanelBody({ heading, inner, names, loadPreview, onAddImage, searchUsers, onLearnName, nextTaskId, onApply, onClose }: RichTextPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [people, setPeople] = useState<{ accountId: string; displayName: string }[]>([]);
  const extensions = useMemo(
    () => [...richTextSchema().filter(e => !CHIP_NAMES.has(e.name)), ...chipViews({ names, loadPreview })],
    [names, loadPreview],
  );
  // Serialize with a throwaway id counter for the "unchanged?" comparison only.
  const probe = { nextTaskId: () => 'new' };
  const [applyError, setApplyError] = useState<string | null>(null);
  const willDrop = useMemo(() => unsupportedFormatting(inner), [inner]);
  const editor = useEditor({
    extensions,
    // Toolbar state (active marks, "in a table") must follow every cursor move.
    shouldRerenderOnTransaction: true,
    content: storageToEditorHtml(inner),
    editorProps: {
      attributes: { class: 'prose-runbook min-h-[50vh] rounded-md border px-3 py-2 text-sm focus:outline-none' },
      handlePaste: (_view, event) => {
        const files = event.clipboardData ? pastedImages(event.clipboardData) : [];
        if (!files.length) return false;
        files.forEach(insertImage);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])].filter(f => f.type.startsWith('image/'));
        if (!files.length) return false;
        files.forEach(insertImage);
        return true;
      },
    },
  });
  const initial = useMemo(() => (editor ? editorJsonToStorage(editor.getJSON(), probe) : ''), [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  function insertImage(file: File) {
    const { filename, previewUrl } = onAddImage(file);
    editor?.chain().focus().insertContent({ type: 'cfImage', attrs: { filename, previewUrl, xml: '' } }).run();
  }

  function apply() {
    if (!editor) return;
    try {
      const edited = editorJsonToStorage(editor.getJSON(), probe);
      onApply(cellAfterEdit(inner, initial, edited) === null ? null : editorJsonToStorage(editor.getJSON(), { nextTaskId }));
    } catch (e) {
      // The serializer refuses to write a protected chip that lost its content.
      setApplyError(e instanceof Error ? e.message : String(e));
    }
  }

  async function findPeople(q: string) {
    setPeople(q.trim().length >= 2 ? await searchUsers(q) : []);
  }

  const btn = (label: string, icon: React.ReactNode, onClick: () => void, active = false) => (
    <Hint label={label}>
      <Button type="button" size="icon" variant={active ? 'secondary' : 'ghost'} className="h-8 w-8" onClick={onClick}>{icon}</Button>
    </Hint>
  );

  if (!editor) return null;
  const inTable = editor.isActive('table');
  // Popovers portal into the panel itself, inside its modal focus trap (see PopoverContent `container`).
  const panelEl = editor.view.dom.closest<HTMLElement>('[role="dialog"]');
  return (
    <>
      <SheetHeader>
        <SheetTitle>{heading}</SheetTitle>
        <SheetDescription>Edits apply to the cell; nothing is sent to Confluence until Review &amp; save. Paste or drop screenshots straight in.</SheetDescription>
      </SheetHeader>
      <div className="flex flex-wrap items-center gap-0.5 rounded-md border bg-muted/30 p-1">
        {btn('Bold', <Bold className="h-4 w-4" />, () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}
        {btn('Italic', <Italic className="h-4 w-4" />, () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}
        {btn('Code', <Code className="h-4 w-4" />, () => editor.chain().focus().toggleCode().run(), editor.isActive('code'))}
        {btn('Bullet list', <List className="h-4 w-4" />, () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'))}
        {btn('Numbered list', <ListOrdered className="h-4 w-4" />, () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'))}
        {btn('Task list', <ListChecks className="h-4 w-4" />, () => editor.chain().focus().toggleTaskList().run(), editor.isActive('taskList'))}
        <Popover>
          <PopoverTrigger asChild><Button type="button" size="icon" variant={editor.isActive('link') ? 'secondary' : 'ghost'} className="h-8 w-8" aria-label="Link"><Link2 className="h-4 w-4" /></Button></PopoverTrigger>
          <PopoverContent className="flex w-80 gap-1.5 p-2" align="start" container={panelEl}>
            <Input value={linkUrl} onChange={e => setLinkUrl(e.target.value)} placeholder="https://…" className="h-8 text-xs" />
            <Button size="sm" className="h-8" onClick={() => {
              const url = linkUrl.trim();
              if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
              else editor.chain().focus().unsetLink().run();
              setLinkUrl('');
            }}>Set</Button>
          </PopoverContent>
        </Popover>
        <span className="mx-1 h-5 w-px bg-border" />
        {btn('Insert table', <TableIcon className="h-4 w-4" />, () => editor.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run())}
        {inTable && btn('Add row', <Rows3 className="h-4 w-4" />, () => editor.chain().focus().addRowAfter().run())}
        {inTable && btn('Add column', <Columns3 className="h-4 w-4" />, () => editor.chain().focus().addColumnAfter().run())}
        {inTable && btn('Delete row', <Trash2 className="h-4 w-4" />, () => editor.chain().focus().deleteRow().run())}
        {inTable && btn('Delete column', <Trash2 className="h-4 w-4 rotate-90" />, () => editor.chain().focus().deleteColumn().run())}
        {btn('Insert drawer (expand)', <PanelBottomOpen className="h-4 w-4" />, () => editor.chain().focus().setDetails().run())}
        {btn('Screenshot', <ImageIcon className="h-4 w-4" />, () => fileRef.current?.click())}
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e => { [...(e.target.files ?? [])].forEach(insertImage); e.target.value = ''; }} />
        <span className="mx-1 h-5 w-px bg-border" />
        <Popover>
          <PopoverTrigger asChild><Button type="button" size="icon" variant="ghost" className="h-8 w-8" aria-label="Mention"><UserRound className="h-4 w-4" /></Button></PopoverTrigger>
          <PopoverContent className="w-64 p-0" align="start" container={panelEl}>
            <Command shouldFilter={false}>
              <CommandInput placeholder="Mention someone…" onValueChange={q => void findPeople(q)} className="h-9 text-xs" />
              <CommandList>
                <CommandEmpty className="py-3 text-center text-xs">Type 2+ letters of a name.</CommandEmpty>
                {people.map(u => (
                  <CommandItem key={u.accountId} value={u.accountId} className="text-xs" onSelect={() => {
                    onLearnName(u.accountId, u.displayName);
                    editor.chain().focus().insertContent([{ type: 'cfMention', attrs: { accountId: u.accountId, xml: '' } }, { type: 'text', text: ' ' }]).run();
                  }}>{u.displayName}</CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {btn('Status badge — click a badge to change its text and colour', <Tag className="h-4 w-4" />, () => {
          requestStatusEditor();
          // No .focus(): Tiptap applies it a frame later, which would pull focus out of the
          // just-opened badge editor and close it.
          editor.chain().insertContent([{ type: 'cfStatus', attrs: { title: 'TODO', colour: 'Grey', xml: '' } }, { type: 'text', text: ' ' }]).run();
        })}
      </div>
      {willDrop.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>This cell has formatting the editor can't keep: {willDrop.join(', ')}. Applying a change removes it — edit this cell in Confluence to keep it.</span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <EditorContent editor={editor} />
      </div>
      {applyError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{applyError}</span>
        </div>
      )}
      <SheetFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={apply}>Apply to cell</Button>
      </SheetFooter>
    </>
  );
}
