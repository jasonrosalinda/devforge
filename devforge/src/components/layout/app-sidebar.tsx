import { useRef } from "react"
import { Anvil, Laptop, Moon, ScrollText, Search, Settings, Sun, X } from "lucide-react"

import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarInput,
    SidebarMenu,
    SidebarMenuBadge,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarRail,
    useSidebar,
} from "@/components/ui/sidebar"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useTheme } from "@/components/provider/theme-provider"
import { useSettingsUi } from "@/context/settings-ui-context"
import { HOME_PAGE, PAGE_GROUPS, matchesPageSearch } from "@/routes/page-routes"
import type { Page } from "@/types/pages.types"
import { SidebarClocks } from "./sidebar-clocks"

interface AppSidebarProps {
    pages: Page[];
    activeTab: string;
    openTabs: string[];
    onOpen: (title: string) => void;
    search: string;
    onSearchChange: (value: string) => void;
    onOpenReleaseNotes: () => void;
}

// Active item: tinted fill + a brand bar on the left edge, so the state isn't carried by colour alone.
const ITEM_CLASS =
    "relative data-[active=true]:before:absolute data-[active=true]:before:left-0 data-[active=true]:before:inset-y-1.5 data-[active=true]:before:w-0.5 data-[active=true]:before:rounded-r-full data-[active=true]:before:bg-sidebar-primary [&[data-active=true]>svg]:text-sidebar-primary"

function NavItem({ page, isActive, isOpen, onOpen }: { page: Page; isActive: boolean; isOpen: boolean; onOpen: (title: string) => void }) {
    const Icon = page.icon;
    return (
        <SidebarMenuItem>
            <SidebarMenuButton
                isActive={isActive}
                tooltip={{
                    children: (
                        <div className="max-w-56">
                            <div className="font-medium">{page.title}</div>
                            {page.description && <div className="text-xs opacity-80">{page.description}</div>}
                        </div>
                    ),
                }}
                aria-current={isActive ? "page" : undefined}
                onClick={() => onOpen(page.title)}
                className={ITEM_CLASS}
            >
                <Icon strokeWidth={1.75} />
                <span>{page.title}</span>
            </SidebarMenuButton>
            {isOpen && !isActive && (
                <SidebarMenuBadge aria-label="Open in a tab" title="Open in a tab">
                    <span className="size-1.5 rounded-full bg-sidebar-foreground/50" />
                </SidebarMenuBadge>
            )}
        </SidebarMenuItem>
    );
}

function ThemeMenu() {
    const { theme, setTheme } = useTheme();
    const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Laptop;
    // No `tooltip` here: with one, SidebarMenuButton returns a Tooltip root, and
    // DropdownMenuTrigger's asChild would then attach to that instead of the button.
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <SidebarMenuButton aria-label={`Theme: ${theme}`}>
                    <Icon strokeWidth={1.75} />
                    <span>Theme</span>
                    <span className="ml-auto text-xs capitalize text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden">{theme}</span>
                </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end">
                <DropdownMenuItem onClick={() => setTheme("light")}><Sun className="mr-2 size-4" />Light</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("dark")}><Moon className="mr-2 size-4" />Dark</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("system")}><Laptop className="mr-2 size-4" />System</DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export function AppSidebar({ pages, activeTab, openTabs, onOpen, search, onSearchChange, onOpenReleaseNotes }: AppSidebarProps) {
    const { openSettings } = useSettingsUi();
    const { state, setOpen } = useSidebar();
    const searchRef = useRef<HTMLInputElement>(null);

    const home = pages.find((p) => p.title === HOME_PAGE);
    const matching = pages.filter((p) => p.title !== HOME_PAGE && matchesPageSearch(p, search));
    const open = new Set(openTabs);

    return (
        <Sidebar collapsible="icon" variant="sidebar">
            <SidebarHeader className="gap-3 pb-0">
                {/* Sits in the title-bar band, so it drags the window too. */}
                <div className="app-drag flex h-9 items-center gap-2.5 px-1 group-data-[collapsible=icon]:px-0">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                        <Anvil className="size-[18px]" strokeWidth={2} />
                    </div>
                    <div className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
                        <span className="text-sm font-semibold tracking-tight">DevForge</span>
                        <span className="text-[11px] tabular-nums text-sidebar-foreground/60">v{__APP_VERSION__}.{__BUILD_NUMBER__}</span>
                    </div>
                </div>

                {state === "collapsed" ? (
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <SidebarMenuButton
                                tooltip="Search tools"
                                onClick={() => {
                                    setOpen(true);
                                    requestAnimationFrame(() => searchRef.current?.focus());
                                }}
                            >
                                <Search strokeWidth={1.75} />
                                <span>Search</span>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>
                ) : (
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-sidebar-foreground/50" />
                        <SidebarInput
                            ref={searchRef}
                            value={search}
                            onChange={(e) => onSearchChange(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Escape") onSearchChange("");
                                if (e.key === "Enter" && matching[0]) onOpen(matching[0].title);
                            }}
                            placeholder="Search tools…"
                            aria-label="Search tools"
                            className="pl-8 pr-8"
                        />
                        {search && (
                            <button
                                type="button"
                                onClick={() => onSearchChange("")}
                                aria-label="Clear search"
                                className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-sidebar-foreground/60 hover:text-sidebar-foreground"
                            >
                                <X className="size-3.5" />
                            </button>
                        )}
                    </div>
                )}
            </SidebarHeader>

            <SidebarContent>
                {home && !search && (
                    <SidebarGroup className="pb-0">
                        <SidebarGroupContent>
                            <SidebarMenu>
                                <NavItem page={home} isActive={activeTab === home.title} isOpen onOpen={onOpen} />
                            </SidebarMenu>
                        </SidebarGroupContent>
                    </SidebarGroup>
                )}

                {PAGE_GROUPS.map((group) => {
                    const items = matching.filter((p) => p.group === group);
                    if (items.length === 0) return null;
                    return (
                        <SidebarGroup key={group} className="py-1">
                            <SidebarGroupLabel className="h-7 text-[11px] uppercase tracking-wider text-sidebar-foreground/50">{group}</SidebarGroupLabel>
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    {items.map((page) => (
                                        <NavItem
                                            key={page.title}
                                            page={page}
                                            isActive={activeTab === page.title}
                                            isOpen={open.has(page.title)}
                                            onOpen={onOpen}
                                        />
                                    ))}
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </SidebarGroup>
                    );
                })}

                {search && matching.length === 0 && (
                    <p className="px-4 py-6 text-center text-xs text-sidebar-foreground/60">
                        No tools match “<span className="font-medium text-sidebar-foreground">{search}</span>”
                    </p>
                )}
            </SidebarContent>

            <SidebarFooter className="border-t border-sidebar-border">
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton tooltip="Settings" onClick={() => openSettings()}>
                            <Settings strokeWidth={1.75} />
                            <span>Settings</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                        <SidebarMenuButton tooltip="Release notes" onClick={onOpenReleaseNotes}>
                            <ScrollText strokeWidth={1.75} />
                            <span>Release notes</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                        <ThemeMenu />
                    </SidebarMenuItem>
                </SidebarMenu>
                <div className="border-t border-sidebar-border pt-2 group-data-[collapsible=icon]:hidden">
                    <SidebarClocks />
                </div>
            </SidebarFooter>

            <SidebarRail />
        </Sidebar>
    )
}
