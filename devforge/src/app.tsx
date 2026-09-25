import { useState, useEffect, useCallback, useRef } from "react";
import { useAppUpdater } from "@/hooks/useAppUpdater";
import { usePageTabs } from "@/hooks/usePageTabs";
import { ThemeProvider } from "@/components/provider/theme-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { SettingsProvider } from "@/context/settings-context";
import { SettingsUiProvider } from "@/context/settings-ui-context";
import { ReleaseNotesModal } from "@/components/release-notes/release-notes-modal";
import { UpdateIndicator } from "@/components/updater/update-indicator";
import { cn } from "@/lib/utils";

import { HOME_PAGE, findPage, pages, renderPage } from "./routes/page-routes";
import { AppHeader } from "./components/layout/app-header";
import { AppSidebar } from "./components/layout/app-sidebar";
import { PageTabs, panelId, tabId } from "./components/layout/page-tabs";
import { TabErrorBoundary } from "./components/layout/tab-error-boundary";
import HomePage from "@/pages/homePage";
import type { Page } from "@/types/pages.types";

const PAGE_TITLES = pages.map((p) => p.title);

export default function App() {
  const { info: updateInfo, install: installUpdate } = useAppUpdater();
  const { openTabs, activeTab, open, close, cycle, activateAt, move } = usePageTabs(PAGE_TITLES, HOME_PAGE);
  const [search, setSearch] = useState<string>("");
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  // Set when a page is opened from the sidebar or a home card, so focus moves to
  // the page for keyboard/screen-reader users. Tab-strip navigation keeps focus
  // on the strip instead.
  const focusPanelRef = useRef(false);

  const openPage = useCallback((title: string) => {
    focusPanelRef.current = true;
    open(title);
  }, [open]);

  useEffect(() => {
    if (!focusPanelRef.current) return;
    focusPanelRef.current = false;
    document.getElementById(panelId(activeTab))?.focus({ preventScroll: true });
  }, [activeTab]);

  // Browser-style tab shortcuts. The Electron app has no application menu
  // (Menu.setApplicationMenu(null)), so Ctrl+W isn't bound to closing the window.
  // In the web build the browser reserves these, so they simply don't fire there.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === "Tab") {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
      } else if (e.key.toLowerCase() === "w" && !e.shiftKey) {
        e.preventDefault();
        close(activeTab);
      } else if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
        e.preventDefault();
        // Ctrl+9 is "last tab", as in browsers.
        activateAt(e.key === "9" ? openTabs.length - 1 : Number(e.key) - 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTab, openTabs.length, close, cycle, activateAt]);

  const openPages = openTabs.map(findPage).filter((p): p is Page => p !== undefined);

  return (
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <SettingsProvider>
      {/* App-wide tooltip defaults. Hovering one hinted control then another inside
          200ms skips the second delay, so scanning a toolbar doesn't stutter. */}
      <TooltipProvider delayDuration={300} skipDelayDuration={200}>
      <SettingsUiProvider>
      <SidebarProvider className="h-svh overflow-hidden">
        <AppSidebar
          pages={pages}
          activeTab={activeTab}
          openTabs={openTabs}
          onOpen={openPage}
          search={search}
          onSearchChange={setSearch}
          onOpenReleaseNotes={() => setReleaseNotesOpen(true)}
        />

        <SidebarInset className="min-w-0 overflow-hidden">
          <AppHeader
            tabs={
              <PageTabs
                tabs={openPages}
                activeTab={activeTab}
                pinned={HOME_PAGE}
                onActivate={open}
                onClose={close}
                onMove={move}
              />
            }
          />

          {/* Every open tab stays mounted so switching back keeps its input,
              results and scroll position; inactive panels are just hidden. */}
          <div className="relative min-h-0 flex-1">
            {openPages.map((page) => {
              const isActive = page.title === activeTab;
              return (
                <section
                  key={page.title}
                  id={panelId(page.title)}
                  role="tabpanel"
                  aria-labelledby={tabId(page.title)}
                  tabIndex={-1}
                  hidden={!isActive}
                  className={cn(
                    "absolute inset-0 flex-col overflow-auto scrollable-content outline-none",
                    // Re-shown panels replay this (display none → flex restarts the animation).
                    "animate-in fade-in-0 duration-150",
                    isActive ? "flex" : "hidden",
                  )}
                >
                  <div className="w-full flex flex-1 flex-col gap-2 px-5 container-fluid mx-auto py-5">
                    {page.title === HOME_PAGE
                      ? <HomePage onNavigate={openPage} search={search} openTabs={openTabs} />
                      : (
                        <TabErrorBoundary title={page.title} onClose={() => close(page.title)}>
                          {renderPage(page.title)}
                        </TabErrorBoundary>
                      )}
                  </div>
                </section>
              );
            })}
          </div>

        </SidebarInset>

        <Toaster />
        <ReleaseNotesModal open={releaseNotesOpen} onClose={() => setReleaseNotesOpen(false)} />

        <UpdateIndicator
          info={updateInfo}
          onRestart={installUpdate}
        />
      </SidebarProvider>
      </SettingsUiProvider>
      </TooltipProvider>
      </SettingsProvider>
    </ThemeProvider>
  );
}
