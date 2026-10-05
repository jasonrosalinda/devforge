// PIC(s) cell editor: the people as chips, plus a shadcn combobox (Popover +
// Command) that searches Confluence users by name and adds them as @mentions.
// The popover renders in a portal, so the sideways-scrolling table can't clip it.

import { useEffect, useState } from 'react';
import { Loader2, Plus, UserRound, Type, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Hint } from '@/components/ui/hint';
import type { Pic } from '@/lib/runbook-cells';

interface PicPickerProps {
  pics: Pic[];
  names: Map<string, string>;
  onChange: (pics: Pic[]) => void;
  search: (query: string) => Promise<{ accountId: string; displayName: string }[]>;
  onLearnName: (accountId: string, name: string) => void;
}

export function PicPicker({ pics, names, onChange, search, onLearnName }: PicPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ accountId: string; displayName: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const q = query.trim();

  // Debounced people search while the popover is open.
  useEffect(() => {
    if (!open || q.length < 2) { setResults([]); return; }
    let live = true;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const found = await search(q);
        if (live) setResults(found);
      } finally {
        if (live) setBusy(false);
      }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [open, q, search]);

  const label = (p: Pic) => ('accountId' in p ? names.get(p.accountId) ?? 'Unknown user' : p.name);
  const taken = new Set(pics.flatMap(p => ('accountId' in p ? [p.accountId] : [])));

  function add(p: Pic) {
    onChange([...pics, p]);
    setQuery('');
    setResults([]);
    setOpen(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {pics.map((p, i) => (
        <span key={i} className={`inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-[11px] ${'accountId' in p ? 'border-info/30 bg-info/10 text-info' : 'border-border bg-muted'}`}>
          {label(p)}
          <button type="button" aria-label={`Remove ${label(p)}`} className="opacity-60 hover:opacity-100" onClick={() => onChange(pics.filter((_, j) => j !== i))}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <Popover open={open} onOpenChange={o => { setOpen(o); if (!o) setQuery(''); }}>
        <Hint label="Add a person (search Confluence users)">
          <PopoverTrigger asChild>
            <button type="button" aria-label="Add PIC" className="rounded-full border border-dashed p-0.5 text-muted-foreground hover:text-foreground">
              <Plus className="h-3 w-3" />
            </button>
          </PopoverTrigger>
        </Hint>
        <PopoverContent className="w-64 p-0" align="start">
          {/* Results come from Confluence already matched — no client-side filtering. */}
          <Command shouldFilter={false}>
            <CommandInput value={query} onValueChange={setQuery} placeholder="Search people…" className="h-9 text-xs" />
            <CommandList>
              {busy && (
                <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Searching…
                </div>
              )}
              {!busy && q.length < 2 && <div className="px-3 py-2 text-xs text-muted-foreground">Type at least 2 letters of a name.</div>}
              {!busy && q.length >= 2 && <CommandEmpty className="py-3 text-center text-xs">No Confluence users match.</CommandEmpty>}
              {results.length > 0 && (
                <CommandGroup heading="Confluence users">
                  {results.map(u => (
                    <CommandItem
                      key={u.accountId}
                      value={u.accountId}
                      disabled={taken.has(u.accountId)}
                      onSelect={() => { onLearnName(u.accountId, u.displayName); add({ accountId: u.accountId }); }}
                      className="text-xs"
                    >
                      <UserRound className="h-3.5 w-3.5" /> {u.displayName}
                      {taken.has(u.accountId) && <span className="ml-auto text-[10px] text-muted-foreground">added</span>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {q.length >= 2 && !busy && (
                <CommandGroup heading="Not in Confluence?">
                  <CommandItem value={`text:${q}`} onSelect={() => add({ name: q })} className="text-xs">
                    <Type className="h-3.5 w-3.5" /> Add “{q}” as text
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
