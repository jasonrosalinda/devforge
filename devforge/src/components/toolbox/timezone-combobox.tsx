import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface ZoneOption {
    /** Zone key passed to onSelect, e.g. "GMT+8". */
    value: string;
    label: string;
    /** Secondary line, e.g. places using the offset. */
    hint?: string;
}

interface TimezoneComboboxProps {
    options: ZoneOption[];
    /** Values not to offer (already shown). */
    exclude: string[];
    onSelect: (value: string) => void;
    placeholder?: string;
}

const LIST_MAX_HEIGHT = 288; // max-h-72

/**
 * Searchable time-zone picker. Replaces a native <datalist>, whose Chromium popup
 * doesn't scroll reliably and can't show a second line per option.
 */
export function TimezoneCombobox({ options: allOptions, exclude, onSelect, placeholder = "Search time zones…" }: TimezoneComboboxProps) {
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const [openUp, setOpenUp] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const listId = useId();

    const options = useMemo(() => {
        const skip = new Set(exclude);
        return allOptions
            .filter((option) => !skip.has(option.value))
            .map((option) => ({ ...option, haystack: `${option.value} ${option.label} ${option.hint ?? ""}`.toLowerCase() }));
    }, [allOptions, exclude]);

    const matches = useMemo(() => {
        const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        return terms.length ? options.filter((o) => terms.every((t) => o.haystack.includes(t))) : options;
    }, [options, query]);

    useEffect(() => setActive(0), [query]);

    // Open upward when there isn't room below (the picker sits low on the page).
    useLayoutEffect(() => {
        if (!open || !rootRef.current) return;
        const rect = rootRef.current.getBoundingClientRect();
        setOpenUp(window.innerHeight - rect.bottom < LIST_MAX_HEIGHT + 16 && rect.top > window.innerHeight - rect.bottom);
    }, [open]);

    // Keep the keyboard-highlighted option in view.
    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
    }, [active]);

    // Close on outside click.
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [open]);

    const choose = (value: string) => {
        onSelect(value);
        setQuery("");
        setOpen(false);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) setOpen(true);
            else setActive((i) => Math.min(i + 1, matches.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
        } else if (e.key === "PageDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 8, matches.length - 1));
        } else if (e.key === "PageUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 8, 0));
        } else if (e.key === "Enter") {
            const match = matches[active];
            if (open && match) {
                e.preventDefault();
                choose(match.value);
            }
        } else if (e.key === "Escape") {
            if (open) {
                e.preventDefault();
                setOpen(false);
            }
        }
    };

    const activeOption = matches[active];

    return (
        <div ref={rootRef} className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
                value={query}
                onChange={(e) => {
                    setQuery(e.target.value);
                    setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onClick={() => setOpen(true)}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                role="combobox"
                aria-expanded={open}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={open && activeOption ? `${listId}-${active}` : undefined}
                aria-label="Time zone to add"
                spellCheck={false}
                className="h-9 pl-8"
            />

            {open && (
                <ul
                    ref={listRef}
                    id={listId}
                    role="listbox"
                    className={cn(
                        "absolute left-0 right-0 z-50 max-h-72 overflow-y-auto overscroll-contain rounded-md border bg-popover p-1 text-popover-foreground shadow-lg scrollable-content",
                        openUp ? "bottom-full mb-1" : "top-full mt-1",
                    )}
                >
                    {matches.length === 0 ? (
                        <li className="px-2 py-6 text-center text-xs text-muted-foreground">No offsets match "{query}"</li>
                    ) : (
                        matches.map((option, index) => (
                            <li
                                key={option.value}
                                id={`${listId}-${index}`}
                                data-index={index}
                                role="option"
                                aria-selected={index === active}
                                // mousedown, not click, so the input doesn't blur and close the list first.
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    choose(option.value);
                                }}
                                onMouseMove={() => index !== active && setActive(index)}
                                className={cn(
                                    "flex cursor-pointer items-baseline gap-3 rounded-sm px-2 py-1.5 text-sm",
                                    index === active && "bg-accent text-accent-foreground",
                                )}
                            >
                                <span className="w-20 shrink-0 font-medium tabular-nums">{option.label}</span>
                                {option.hint && <span className="truncate text-xs text-muted-foreground">{option.hint}</span>}
                            </li>
                        ))
                    )}
                </ul>
            )}
        </div>
    );
}
