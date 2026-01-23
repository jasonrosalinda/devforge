import { useState } from "react";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "./components/layout/app-sidebar";
import { AppHeader } from "./components/layout/app-header";
import { ThemeProvider } from "@/components/provider/theme-provider"
import { Toaster } from "@/components/ui/sonner"

import LocalizationPage from "./pages/localizationPage";
import PageSpeedResultPage from "./pages/pagespeedResultPage";
import MEDUCachePage from "./pages/meduCachePage";
import CSSAuditPage from "./pages/cssAuditPage";

export default function App() {
    const [activePage, setActivePage] = useState("");

    // Render the active page component
    const renderPage = () => {
        switch (activePage) {
            case "Translation":
                return <LocalizationPage />;
            case "PageSpeed":
                return <PageSpeedResultPage />;
            case "MEDU Cache":
                return <MEDUCachePage />;
            case "CSS Audit":
                return <CSSAuditPage />;
            default:
                return <></>;
        }
    };

    return (
        <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
            <SidebarProvider>
                <AppSidebar activePage={activePage} setActivePage={setActivePage} />
                <SidebarInset>
                    <AppHeader pageName={activePage} />
                    <div className="flex flex-1 flex-col">
                        <div className="@container/main flex flex-1 flex-col gap-2 px-5 container mx-auto py-5">
                            {renderPage()}
                        </div>
                    </div>
                    <Toaster />
                </SidebarInset>
            </SidebarProvider>
        </ThemeProvider>
    );
}
