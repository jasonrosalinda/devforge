import { useEffect, useRef, useState } from 'react';
import { Bold, Italic, List, ListOrdered, Image as ImageIcon, Undo2 } from 'lucide-react';

interface RichTextFieldProps {
  /** HTML. Empty string renders the placeholder. */
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: number;
  /**
   * 'boxed' draws its own border. 'flat' drops it and leans on a tinted background
   * instead — for fields sitting inside a card, where a second border reads as a
   * box within a box.
   */
  variant?: 'boxed' | 'flat';
}

/** Files bigger than this bloat the report past what a mail client will carry. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error('Could not read the image.'));
    fr.readAsDataURL(file);
  });

/**
 * A small rich-text field for the RCA sections: bold, italic, lists, and images
 * pasted, dropped or picked. Images are embedded as data URIs so the report stays
 * one self-contained document — the PDF and the Word file carry the screenshots
 * without a folder of assets beside them.
 *
 * `document.execCommand` is deprecated but is still the only in-browser editing
 * primitive that works without a dependency, and Electron ships the Chromium that
 * implements it. Pasted content is flattened to plain text (images excepted), so
 * markup from a browser or Word cannot ride in.
 */
export function RichTextField({ value, onChange, placeholder, minHeight = 90, variant = 'boxed' }: RichTextFieldProps) {
  const flat = variant === 'flat';
  const ref = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only write into the DOM when the incoming value differs from what is already
  // there: assigning innerHTML on every keystroke would reset the caret.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.innerHTML !== value) el.innerHTML = value || '';
  }, [value]);

  const emit = () => onChange(ref.current?.innerHTML ?? '');

  const exec = (command: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(command, false, arg);
    emit();
  };

  const insertImage = async (file: File) => {
    setError(null);
    if (!file.type.startsWith('image/')) return;
    if (file.size > MAX_IMAGE_BYTES) {
      setError(`${file.name || 'That image'} is ${(file.size / 1024 / 1024).toFixed(1)} MB — keep attachments under 4 MB.`);
      return;
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      ref.current?.focus();
      document.execCommand('insertHTML', false, `<img src="${dataUrl}" alt="${file.name || 'attachment'}" />`);
      emit();
    } catch (e: any) {
      setError(e?.message ?? 'Could not attach that image.');
    }
  };

  const pickImage = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void insertImage(file);
    };
    input.click();
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const image = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'));
    if (image) {
      const file = image.getAsFile();
      if (file) { e.preventDefault(); void insertImage(file); return; }
    }
    // Everything else lands as text — a paste from Word or a browser otherwise
    // carries fonts, colours and tables that have nothing to do with this report.
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    emit();
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    void files.reduce<Promise<void>>((chain, f) => chain.then(() => insertImage(f)), Promise.resolve());
  };

  const isEmpty = !value || value === '<br>' || value === '<p><br></p>';

  return (
    <div className="flex flex-col">
      <div
        className={`flex items-center gap-0.5 rounded-t-md px-1 py-0.5 ${flat ? 'bg-muted/40' : 'border border-b-0 border-border bg-muted/30'}`}
        data-html2canvas-ignore="true"
      >
        {([
          { icon: Bold,        cmd: 'bold',            label: 'Bold' },
          { icon: Italic,      cmd: 'italic',          label: 'Italic' },
          { icon: List,        cmd: 'insertUnorderedList', label: 'Bulleted list' },
          { icon: ListOrdered, cmd: 'insertOrderedList',   label: 'Numbered list' },
        ] as const).map(({ icon: Icon, cmd, label }) => (
          <button
            key={cmd}
            type="button"
            onMouseDown={e => e.preventDefault()}   // keep the selection while clicking
            onClick={() => exec(cmd)}
            title={label}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Icon className="h-3 w-3" />
          </button>
        ))}
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={pickImage}
          title="Attach an image — or paste / drop one straight into the field"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ImageIcon className="h-3 w-3" />
        </button>
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={() => exec('undo')}
          title="Undo"
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Undo2 className="h-3 w-3" />
        </button>
      </div>

      <div className="relative">
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={placeholder}
          onInput={emit}
          onBlur={() => { setFocused(false); emit(); }}
          onFocus={() => setFocused(true)}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={e => { if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault(); }}
          spellCheck={false}
          className={`rca-rich w-full overflow-y-auto rounded-b-md px-3 py-2 text-xs leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring ${flat ? 'bg-muted/15' : 'border border-border bg-transparent'}`}
          style={{ minHeight, maxHeight: 420 }}
        />
        {isEmpty && !focused && (
          <span className="pointer-events-none absolute left-3 top-2 text-xs text-muted-foreground">
            {placeholder}
          </span>
        )}
      </div>

      {error && <span className="mt-1 text-[10px] text-destructive">{error}</span>}

      <style>{`
        .rca-rich img { max-width: 100%; height: auto; display: block; margin: 6px 0; border-radius: 4px; }
        .rca-rich ul, .rca-rich ol { margin: 4px 0; padding-left: 18px; }
        .rca-rich li { margin: 2px 0; }
        .rca-rich p { margin: 4px 0; }
      `}</style>
    </div>
  );
}
