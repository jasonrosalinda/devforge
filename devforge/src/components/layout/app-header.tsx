import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { ThemeModeToggle } from "../ui/theme-mode-toggle"
import { ChevronLeft, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useState, useEffect } from "react"

interface AppHeaderProps {
    pageName: string;
    onBack?: (() => void) | undefined;
    search?: string | undefined;
    onSearchChange?: ((val: string) => void) | undefined;
}

export function AppHeader({ pageName, onBack, search, onSearchChange }: AppHeaderProps) {
    const [time, setTime] = useState<string>("");
    const [date, setDate] = useState<string>("");

    useEffect(() => {
        const update = () => {
            const now = new Date();
            setTime(now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
            setDate(now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }));
        };
        update();
        const id = setInterval(update, 1000);
        return () => clearInterval(id);
    }, []);

    const isHome = !onBack;

    return (
        <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
            <div className="flex w-full items-center gap-2 px-4 lg:px-6 py-2">
                {onBack ? (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={onBack}
                        className="flex items-center gap-1 px-2 text-muted-foreground hover:text-foreground"
                    >
                        <ChevronLeft className="w-4 h-4" />
                        <span className="text-sm">Home</span>
                    </Button>
                ) : (
                    <SidebarTrigger className="-ml-1" />
                )}

                <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
                <h1 className="text-base font-medium">{pageName}</h1>

                <div className="ml-auto flex items-center gap-3">

                    {isHome && (
                        <div className="hidden sm:flex flex-col items-end leading-none">
                            <span className="text-sm font-semibold tabular-nums">{time}</span>
                            <span className="text-xs text-muted-foreground">{date}</span>
                        </div>
                    )}

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

                    <ThemeModeToggle />
                </div>
            </div>
        </header>
    );
}