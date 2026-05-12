import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { ThemeModeToggle } from "../ui/theme-mode-toggle"
import { ChevronLeft, Download, Search, Settings, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useState, useEffect } from "react"
import type { LucideIcon } from "lucide-react"
import type { IconType } from "react-icons"
import { isElectron } from "@/lib/environment";

type PageIcon = LucideIcon | IconType;

interface AppHeaderProps {
    pageName: string;
    pageIcon?: PageIcon | undefined;
    onBack?: (() => void) | undefined;
    search?: string | undefined;
    onSearchChange?: ((val: string) => void) | undefined;
    onOpenSettings?: () => void;
}

interface ClockDisplay {
    time: string;
    date: string;
}

function useClockForZone(timeZone: string): ClockDisplay {
    const [display, setDisplay] = useState<ClockDisplay>({ time: "", date: "" });

    useEffect(() => {
        const update = () => {
            const now = new Date();
            setDisplay({
                time: now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone }),
                date: now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", timeZone }),
            });
        };
        update();
        const id = setInterval(update, 1000);
        return () => clearInterval(id);
    }, [timeZone]);

    return display;
}

export function AppHeader({ pageName, pageIcon: Icon, onBack, search, onSearchChange, onOpenSettings }: AppHeaderProps) {
    const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const localLabel = new Intl.DateTimeFormat([], { timeZoneName: "short", timeZone: localTimeZone })
        .formatToParts(new Date())
        .find(p => p.type === "timeZoneName")?.value ?? localTimeZone;

    const local = useClockForZone(localTimeZone);
    const utc = useClockForZone("UTC");

    const isDesktop = isElectron();
    const downloadUrl = `https://github.com/jasonrosalinda/devforge/releases/download/v${__APP_VERSION__}/devForge.Setup.${__APP_VERSION__}.exe`;

    const isHome = !onBack;

    return (
        <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
            <div className="flex w-full items-center gap-2 px-4 lg:px-6 py-2">

                {onBack && (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={onBack}
                        className="flex items-center gap-1 px-2 text-muted-foreground hover:text-foreground"
                    >
                        <ChevronLeft className="w-4 h-4" />
                        <span className="text-sm">Back</span>
                    </Button>
                )}

                {onBack && <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />}

                <div className="flex items-center gap-1.5">
                    {Icon && <Icon className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
                    <h1 className="text-base font-medium">{pageName}</h1>
                </div>

                <div className="ml-auto flex items-center gap-3">

                    {isHome && onSearchChange !== undefined && (
                        <div className="relative hidden md:block">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                            <Input
                                value={search ?? ""}
                                onChange={(e) => onSearchChange(e.target.value)}
                                placeholder="Search pages…"
                                className="pl-8 pr-8 h-8 w-44 text-sm"
                            />
                            {search && (
                                <button
                                    onClick={() => onSearchChange("")}
                                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            )}
                        </div>
                    )}

                    {/* Local Timezone Clock */}
                    <div className="hidden sm:flex flex-col items-end leading-none">
                        <div className="flex items-baseline gap-1">
                            <span className="text-sm font-semibold tabular-nums">{local.time}</span>
                            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{localLabel}</span>
                        </div>
                        <span className="text-xs text-muted-foreground">{local.date}</span>
                    </div>

                    <Separator orientation="vertical" className="hidden sm:block data-[orientation=vertical]:h-6" />

                    {/* UTC Clock */}
                    <div className="hidden sm:flex flex-col items-end leading-none">
                        <div className="flex items-baseline gap-1">
                            <span className="text-sm font-semibold tabular-nums">{utc.time}</span>
                            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">UTC</span>
                        </div>
                        <span className="text-xs text-muted-foreground">{utc.date}</span>
                    </div>

                    {!isDesktop &&
                        <Button variant="ghost" size="sm" asChild className="flex items-center gap-1 px-2 text-muted-foreground hover:text-foreground">
                            <a href={downloadUrl} target="_blank" rel="noreferrer">
                                <Download className="w-4 h-4" />
                            </a>
                        </Button>
                    }
                    {onOpenSettings && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={onOpenSettings} title="Settings">
                            <Settings className="w-4 h-4" />
                        </Button>
                    )}
                    <ThemeModeToggle />
                </div>
            </div>
        </header>
    );
}