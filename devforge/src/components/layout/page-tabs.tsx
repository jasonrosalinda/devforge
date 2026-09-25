import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type DragEvent } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Page } from "@/types/pages.types";

interface PageTabsProps {
    tabs: Page[];
    activeTab: string;
    /** Always first, icon-only, not closable or draggable. */
    pinned: string;
    onActivate: (title: string) => void;
    onClose: (title: string) => void;
    onMove: (title: string, toIndex: number) => void;
}

export const tabId = (title: string) => `tab-${title.replace(/\s+/g, "-").toLowerCase()}`;
export const panelId = (title: string) => `panel-${title.replace(/\s+/g, "-").toLowerCase()}`;

/**
 * Browser-style tab strip. Tabs are the page's own buttons (role="tab") with a
 * sibling close button, so the close control isn't nested inside the tab.
 * Roving tabindex: only the active tab is in the Tab order; arrows move between tabs.
 */
export function PageTabs({ tabs, activeTab, pinned, onActivate, onClose, onMove }: PageTabsProps) {
    const stripRef = useRef<HTMLDivElement>(null);
    const tabRefs = useRef(new Map<string, HTMLButtonElement>());
    const [dragging, setDragging] = useState<string | null>(null);
    const [dropIndex, setDropIndex] = useState<number | null>(null);

    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);

    // Which way the strip can still scroll; drives the chevron buttons.
    const measure = useCallback(() => {
        const el = stripRef.current;
        if (!el) return;
        setCanScrollLeft(el.scrollLeft > 1);
        setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    }, []);

    const activeRef = useRef(activeTab);
    const revealActive = useCallback(() => {
        // The wrapper, not the tab button, so the close ✕ comes into view too.
        tabRefs.current.get(activeRef.current)?.closest('[role="presentation"]')
            ?.scrollIntoView({ block: "nearest", inline: "nearest" });
        measure();
    }, [measure]);

    // The strip's width settles after first paint (sidebar, clocks, fonts) and
    // changes with the window, so re-reveal the active tab whenever it resizes.
    useEffect(() => {
        const el = stripRef.current;
        if (!el) return;
        const observer = new ResizeObserver(revealActive);
        observer.observe(el);
        return () => observer.disconnect();
    }, [revealActive]);

    // Keep the active tab visible when the strip overflows.
    useEffect(() => {
        activeRef.current = activeTab;
        revealActive();
    }, [activeTab, tabs.length, revealActive]);

    const scrollStrip = (direction: -1 | 1) => {
        const el = stripRef.current;
        if (!el) return;
        el.scrollBy({ left: direction * Math.max(160, el.clientWidth * 0.6), behavior: "smooth" });
    };

    const overflowing = canScrollLeft || canScrollRight;

    const focusTab = (page: Page | undefined) => {
        if (!page) return;
        onActivate(page.title);
        tabRefs.current.get(page.title)?.focus();
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number, title: string) => {
        switch (e.key) {
            case "ArrowRight":
                e.preventDefault();
                focusTab(tabs[(index + 1) % tabs.length]);
                break;
            case "ArrowLeft":
                e.preventDefault();
                focusTab(tabs[(index - 1 + tabs.length) % tabs.length]);
                break;
            case "Home":
                e.preventDefault();
                focusTab(tabs[0]);
                break;
            case "End":
                e.preventDefault();
                focusTab(tabs[tabs.length - 1]);
                break;
            case "Delete":
                if (title !== pinned) {
                    e.preventDefault();
                    const neighbour = tabs[index + 1] ?? tabs[index - 1];
                    onClose(title);
                    if (neighbour) requestAnimationFrame(() => tabRefs.current.get(neighbour.title)?.focus());
                }
                break;
        }
    };

    const handleDragOver = (e: DragEvent<HTMLDivElement>, index: number) => {
        if (!dragging) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const after = e.clientX > rect.left + rect.width / 2;
        setDropIndex(Math.max(1, index + (after ? 1 : 0)));
    };

    const handleDrop = () => {
        if (dragging && dropIndex !== null) {
            const from = tabs.findIndex((t) => t.title === dragging);
            // Index is measured against the strip *with* the dragged tab still in it.
            onMove(dragging, dropIndex > from ? dropIndex - 1 : dropIndex);
        }
        setDragging(null);
        setDropIndex(null);
    };

    return (
        <div className="flex h-full min-w-0 flex-1 items-end">
        {overflowing && (
            <StripScrollButton direction={-1} disabled={!canScrollLeft} onClick={() => scrollStrip(-1)} />
        )}
        <div
            ref={stripRef}
            role="tablist"
            aria-label="Open pages"
            className="tabstrip-scroll flex h-full min-w-0 flex-1 items-end gap-px overflow-x-auto"
            onScroll={measure}
            onWheel={(e) => {
                if (stripRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                    stripRef.current.scrollLeft += e.deltaY;
                }
            }}
        >
            {tabs.map((page, index) => {
                const { title, icon: Icon } = page;
                const isActive = title === activeTab;
                const isPinned = title === pinned;
                const showDropBefore = dragging !== null && dropIndex === index && dragging !== title;
                const showDropAfter = dragging !== null && dropIndex === index + 1 && index === tabs.length - 1;
                // Browser-style divider between two inactive tabs; hidden next to the active one.
                const nextTitle = tabs[index + 1]?.title;
                const showDivider = !isActive && nextTitle !== undefined && nextTitle !== activeTab && !dragging;

                return (
                    <div
                        key={title}
                        role="presentation"
                        draggable={!isPinned}
                        onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = "move";
                            setDragging(title);
                        }}
                        onDragOver={(e) => handleDragOver(e, index)}
                        onDrop={handleDrop}
                        onDragEnd={() => { setDragging(null); setDropIndex(null); }}
                        onAuxClick={(e) => {
                            // Middle-click closes, like a browser.
                            if (e.button === 1 && !isPinned) {
                                e.preventDefault();
                                onClose(title);
                            }
                        }}
                        className={cn(
                            "app-no-drag group/tab relative flex h-9 shrink items-center rounded-t-lg border border-b-0 transition-colors duration-150",
                            // Tabs shrink down to a readable width, then the strip scrolls.
                            isPinned ? "shrink-0" : "min-w-[8.5rem] max-w-[13rem] flex-[0_1_13rem]",
                            isActive
                                ? "z-10 -mb-px h-[calc(2.25rem+1px)] border-border bg-background text-foreground"
                                : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                            dragging === title && "opacity-50",
                            // Active-tab marker: brand bar across the top (shape + colour, not colour alone).
                            isActive && "before:absolute before:inset-x-3 before:top-0 before:h-0.5 before:rounded-b-full before:bg-brand",
                            showDropBefore && "after:absolute after:-left-px after:inset-y-1.5 after:w-0.5 after:rounded-full after:bg-brand",
                            showDropAfter && "after:absolute after:-right-px after:inset-y-1.5 after:w-0.5 after:rounded-full after:bg-brand",
                        )}
                    >
                        <Tooltip delayDuration={600}>
                            <TooltipTrigger asChild>
                                <button
                                    ref={(el) => {
                                        if (el) tabRefs.current.set(title, el);
                                        else tabRefs.current.delete(title);
                                    }}
                                    type="button"
                                    role="tab"
                                    id={tabId(title)}
                                    aria-selected={isActive}
                                    aria-controls={panelId(title)}
                                    aria-label={isPinned ? title : undefined}
                                    tabIndex={isActive ? 0 : -1}
                                    onClick={() => onActivate(title)}
                                    onKeyDown={(e) => handleKeyDown(e, index, title)}
                                    className={cn(
                                        "flex h-full min-w-0 flex-1 items-center gap-2 rounded-t-lg text-[13px] outline-none",
                                        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                        isPinned ? "px-3" : "pl-3 pr-1",
                                        isActive && "font-medium",
                                    )}
                                >
                                    <Icon className={cn("size-4 shrink-0", isActive && "text-brand")} strokeWidth={1.75} />
                                    {!isPinned && <span className="truncate">{title}</span>}
                                </button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">{title}</TooltipContent>
                        </Tooltip>

                        {!isPinned && (
                            <button
                                type="button"
                                tabIndex={-1}
                                aria-label={`Close ${title}`}
                                onClick={() => onClose(title)}
                                className={cn(
                                    "mr-1.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground",
                                    "transition-[opacity,background-color,color] duration-150 hover:bg-muted hover:text-foreground",
                                    isActive ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100",
                                )}
                            >
                                <X className="size-3.5" />
                            </button>
                        )}

                        {showDivider && (
                            <span aria-hidden className="pointer-events-none absolute -right-px top-1/2 h-4 w-px -translate-y-1/2 bg-border group-hover/tab:opacity-0" />
                        )}
                    </div>
                );
            })}
        </div>
        {overflowing && (
            <StripScrollButton direction={1} disabled={!canScrollRight} onClick={() => scrollStrip(1)} />
        )}
        </div>
    );
}

/** Chevron at either end of an overflowing strip; disabled once that end is reached. */
function StripScrollButton({ direction, disabled, onClick }: { direction: -1 | 1; disabled: boolean; onClick: () => void }) {
    const Icon = direction < 0 ? ChevronLeft : ChevronRight;
    return (
        <div className="flex h-full shrink-0 items-center px-0.5">
            <button
                type="button"
                tabIndex={-1}
                disabled={disabled}
                onClick={onClick}
                aria-label={direction < 0 ? "Scroll tabs left" : "Scroll tabs right"}
                className="app-no-drag flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
            >
                <Icon className="size-4" />
            </button>
        </div>
    );
}
