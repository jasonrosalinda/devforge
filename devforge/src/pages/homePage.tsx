import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { HOME_PAGE, PAGE_GROUPS, matchesPageSearch, pages } from "@/routes/page-routes";
import type { Page } from "@/types/pages.types";

interface HomePageProps {
    onNavigate?: (pageTitle: string) => void;
    search?: string;
    /** Titles currently open in a tab; their cards get an "Open" badge. */
    openTabs?: string[];
}

function greetingFor(hour: number): string {
    return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function ToolCard({ page, isOpen, onOpen }: { page: Page; isOpen: boolean; onOpen: (title: string) => void }) {
    const Icon = page.icon;
    return (
        <button
            type="button"
            onClick={() => onOpen(page.title)}
            className="group flex items-start gap-3 rounded-xl border bg-card p-4 text-left shadow-sm outline-none
                       transition-[border-color,transform,box-shadow] duration-150 ease-out
                       hover:-translate-y-px hover:border-brand/40 hover:shadow-md
                       focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background
                       active:translate-y-0"
        >
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand ring-1 ring-inset ring-brand/20">
                <Icon className="size-5" strokeWidth={1.75} />
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">{page.title}</span>
                    {isOpen && (
                        <span className="rounded-full border border-brand/30 bg-brand/10 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-brand">
                            Open
                        </span>
                    )}
                </div>
                {page.description && (
                    <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{page.description}</p>
                )}
            </div>
            <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground" />
        </button>
    );
}

export default function HomePage({ onNavigate = () => { }, search = "", openTabs = [] }: HomePageProps) {
    const greeting = useMemo(() => greetingFor(new Date().getHours()), []);
    const open = new Set(openTabs);

    const filtered = pages.filter((p) => p.title !== HOME_PAGE && matchesPageSearch(p, search));

    return (
        <div className="flex w-full flex-col gap-6">
            <div className="border-b pb-4">
                <h1 className="text-xl font-semibold tracking-tight">{greeting}</h1>
                <p className="mt-0.5 text-sm text-muted-foreground">
                    Pick a tool to open it in a new tab. Already-open tools jump to their tab.
                </p>
            </div>

            {search && filtered.length === 0 ? (
                <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
                    <p className="text-sm">
                        No tools match "<span className="font-semibold">{search}</span>"
                    </p>
                </div>
            ) : (
                // One grid in sidebar-group order; the sidebar already shows the group labels,
                // and per-group sections here left mostly-empty rows of one or two cards.
                <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
                    {PAGE_GROUPS.flatMap((group) => filtered.filter((p) => p.group === group)).map((page) => (
                        <ToolCard key={page.title} page={page} isOpen={open.has(page.title)} onOpen={onNavigate} />
                    ))}
                </div>
            )}
        </div>
    );
}
