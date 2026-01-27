import { useState } from "react";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "./components/layout/app-sidebar";
import { AppHeader } from "./components/layout/app-header";
import { ThemeProvider } from "@/components/provider/theme-provider"
import { Toaster } from "@/components/ui/sonner"

import { pages, renderPage } from "./routes/page-routes";

export default function App() {
    const [activePage, setActivePage] = useState("");

    return (
        <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
            <SidebarProvider>
                <AppSidebar pages={pages} activePage={activePage} setActivePage={setActivePage} />
                <SidebarInset>
                    <AppHeader pageName={activePage} />
                    <div className="flex flex-1 flex-col">
                        <div className="@container/main flex flex-1 flex-col gap-2 px-5 container mx-auto py-5">
                            {renderPage(activePage)}
                        </div>
                    </div>
                    <Toaster />
                </SidebarInset>
            </SidebarProvider>
        </ThemeProvider>
    );
}
