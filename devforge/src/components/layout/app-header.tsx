import type { ReactNode } from "react"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Hint } from "@/components/ui/hint";
import { isElectron } from "@/lib/environment";

interface AppHeaderProps {
    /** The tab strip; fills the space after the sidebar toggle. */
    tabs: ReactNode;
}

export function AppHeader({ tabs }: AppHeaderProps) {
    const isDesktop = isElectron();
    const downloadUrl = `https://github.com/jasonrosalinda/devforge/releases/download/v${__APP_VERSION__}/devForge.Setup.${__APP_VERSION__}.exe`;

    return (
        // Doubles as the desktop title bar: empty space drags the window, controls opt out.
        <header className="app-drag pr-titlebar-overlay sticky top-0 z-20 flex h-[var(--header-height)] shrink-0 items-end gap-2 border-b bg-tabbar pl-2">
            <div className="app-no-drag flex h-full items-center">
                <Hint label="Toggle sidebar (Ctrl+B)">
                    <SidebarTrigger className="h-8 w-8 text-muted-foreground hover:text-foreground" />
                </Hint>
            </div>

            {tabs}

            {!isDesktop &&
                <div className="flex h-full shrink-0 items-center pl-2 pr-2">
                    <Hint label="Download the desktop app">
                        <Button variant="ghost" size="icon" asChild className="app-no-drag h-8 w-8 text-muted-foreground hover:text-foreground">
                            <a href={downloadUrl} target="_blank" rel="noreferrer" aria-label="Download the desktop app">
                                <Download className="w-4 h-4" />
                            </a>
                        </Button>
                    </Hint>
                </div>
            }
        </header>
    );
}
