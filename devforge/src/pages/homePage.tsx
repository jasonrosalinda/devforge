import { useState, useEffect, useRef } from "react";
import { pages } from "@/routes/page-routes";
import type { Page } from "@/types/pages.types";

interface HomePageProps {
    onNavigate?: (pageTitle: string, rect: DOMRect) => void;
    search?: string;
}

interface AppIconProps {
    page: Page;
    index: number;
    onOpen: (page: Page, rect: DOMRect) => void;
    visible: boolean;
}

function AppIcon({ page, index, onOpen, visible }: AppIconProps) {
    const [pressed, setPressed] = useState<boolean>(false);
    const iconRef = useRef<HTMLDivElement>(null);

    const handleClick = () => {
        setPressed(true);
        setTimeout(() => {
            setPressed(false);
            if (iconRef.current) {
                onOpen(page, iconRef.current.getBoundingClientRect());
            }
        }, 130);
    };

    const IconComponent = page.icon;

    return (
        <div
            ref={iconRef}
            className="flex flex-col items-center gap-2 cursor-pointer select-none group"
            style={{
                opacity: visible ? 1 : 0,
                transform: visible ? "scale(1) translateY(0)" : "scale(0.5) translateY(24px)",
                transition: `opacity 0.45s ease ${index * 40}ms, transform 0.45s cubic-bezier(0.34,1.4,0.64,1) ${index * 40}ms`,
            }}
            onClick={handleClick}
        >
            <div
                className="w-[72px] h-[72px] rounded-[22px] flex items-center justify-center
                           bg-muted border border-border
                           group-hover:bg-accent group-hover:border-accent-foreground/20
                           transition-all duration-150"
                style={{
                    transform: pressed ? "scale(0.85)" : "scale(1)",
                    transition: "transform 0.13s cubic-bezier(0.34,1.56,0.64,1), background 0.15s, border-color 0.15s",
                    boxShadow: pressed
                        ? "0 1px 4px rgba(0,0,0,0.15)"
                        : "0 2px 8px rgba(0,0,0,0.08)",
                }}
            >
                <IconComponent
                    className="w-8 h-8 text-foreground"
                    strokeWidth={1.6}
                />
            </div>
            <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground text-center leading-tight max-w-[80px] truncate transition-colors">
                {page.title}
            </span>
        </div>
    );
}

export default function HomePage({ onNavigate = () => { }, search = "" }: HomePageProps) {
    const [iconsVisible, setIconsVisible] = useState<boolean>(false);
    const [greeting, setGreeting] = useState<string>("");

    useEffect(() => {
        const h = new Date().getHours();
        setGreeting(h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
        const t = setTimeout(() => setIconsVisible(true), 80);
        return () => clearTimeout(t);
    }, []);

    const visiblePages = pages.filter((p) => p.title !== "Home");

    const filtered = search.trim()
        ? visiblePages.filter((p) =>
            p.title.toLowerCase().includes(search.toLowerCase())
        )
        : visiblePages;

    return (
        <div className="flex flex-col h-full w-full">

            <div className="flex-1 overflow-y-auto pb-10">
                {search && filtered.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
                        <p className="text-sm">
                            No pages match "<span className="font-semibold">{search}</span>"
                        </p>
                    </div>
                ) : (
                    <>
                        {search && (
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-5">
                                {filtered.length} result{filtered.length !== 1 ? "s" : ""}
                            </p>
                        )}
                        <div
                            className="grid gap-x-4 gap-y-8"
                            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}
                        >
                            {filtered.map((page, i) => (
                                <AppIcon
                                    key={page.title}
                                    page={page}
                                    index={i}
                                    onOpen={(p, rect) => onNavigate(p.title, rect)}
                                    visible={iconsVisible}
                                />
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}