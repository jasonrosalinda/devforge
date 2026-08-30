import { useState, useRef, useCallback } from "react";
import { useAppUpdater } from "@/hooks/useAppUpdater";
import { ThemeProvider } from "@/components/provider/theme-provider";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Home } from "lucide-react";
import { SettingsProvider } from "@/context/settings-context";
import { SettingsModal } from "@/components/settings/settings-modal";
import { ReleaseNotesModal } from "@/components/release-notes/release-notes-modal";
import { UpdateIndicator } from "@/components/updater/update-indicator";

import { pages, renderPage } from "./routes/page-routes";
import { BuildLabel } from "./components/ui/buildLabel";
import { AccessMode } from "./components/ui/accessMode";
import { AppHeader } from "./components/layout/app-header";
import HomePage from "@/pages/homePage";

type Phase = "idle" | "launching" | "open" | "closing";

const LAUNCH_STYLES = `
  .content-wrap {
    transition: filter 0.35s ease, transform 0.35s ease;
    will-change: transform, filter;
    transform-origin: center top;
  }
  .content-wrap.blurred {
    filter: brightness(0.5) blur(6px) saturate(0.7);
    transform: scale(0.97);
    pointer-events: none;
    user-select: none;
  }
  .app-sheet {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    z-index: 50;
    background: white;
    will-change: transform, opacity, border-radius;
  }
  .dark .app-sheet {
    background: hsl(var(--background));
  }
  .app-sheet.phase-launching {
    animation: sheetIn 0.4s cubic-bezier(0.22, 0.61, 0.36, 1) forwards;
  }
  .app-sheet.phase-open {
    transform: scale(1);
    opacity: 1;
    border-radius: 0;
  }
  .app-sheet.phase-closing {
    animation: sheetOut 0.36s cubic-bezier(0.55, 0, 1, 0.45) forwards;
  }
  @keyframes sheetIn {
    0%   { transform: scale(0.05); opacity: 0;  border-radius: 28px; }
    55%  { opacity: 1;                          border-radius: 14px; }
    100% { transform: scale(1);   opacity: 1;  border-radius: 0;    }
  }
  @keyframes sheetOut {
    0%   { transform: scale(1);    opacity: 1; border-radius: 0;    }
    45%  { opacity: 1;                         border-radius: 18px; }
    100% { transform: scale(0.05); opacity: 0; border-radius: 28px; }
  }
`;

export default function App() {
  const { info: updateInfo, install: installUpdate } = useAppUpdater();
  const [activePage, setActivePage] = useState<string>("Home");
  const [phase, setPhase] = useState<Phase>("idle");
  const [originStyle, setOriginStyle] = useState<string>("50% 50%");
  const [search, setSearch] = useState<string>("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const pendingPage = useRef<string>("Home");

  const isAppVisible = phase === "launching" || phase === "open" || phase === "closing";
  const contentBlurred = isAppVisible;

  const activePageDef = pages.find((p) => p.title === activePage);
  const activeIcon = isAppVisible ? activePageDef?.icon : Home;

  const handleNavigate = useCallback((pageTitle: string, rect: DOMRect) => {
    const vw = window.innerWidth;
    const contentEl = document.getElementById("home-content");
    const offsetTop = contentEl?.getBoundingClientRect().top ?? 0;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2 - offsetTop;
    const ch = contentEl?.clientHeight ?? window.innerHeight;
    setOriginStyle(`${(cx / vw) * 100}% ${(cy / ch) * 100}%`);
    pendingPage.current = pageTitle;
    setActivePage(pageTitle);
    setPhase("launching");
    setTimeout(() => setPhase("open"), 420);
  }, []);

  const handleClose = useCallback(() => {
    setPhase("closing");
    setTimeout(() => {
      setPhase("idle");
      setActivePage("Home");
    }, 380);
  }, []);

  return (
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <SettingsProvider>
      {/* App-wide tooltip defaults. Hovering one hinted control then another inside
          200ms skips the second delay, so scanning a toolbar doesn't stutter. */}
      <TooltipProvider delayDuration={300} skipDelayDuration={200}>
      <SidebarProvider>
        <style>{LAUNCH_STYLES}</style>

        <div className="w-screen min-h-screen flex flex-col">

          <AppHeader
            pageName={isAppVisible ? activePage : "Home"}
            pageIcon={activeIcon}
            search={!isAppVisible ? search : undefined}
            onSearchChange={!isAppVisible ? setSearch : undefined}
            onBack={isAppVisible ? handleClose : undefined}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenReleaseNotes={() => setReleaseNotesOpen(true)}
          />

          <div
            id="home-content"
            className="relative flex flex-1 overflow-hidden"
          >
            <div className={`content-wrap w-full flex flex-col overflow-hidden ${contentBlurred ? "blurred" : ""}`}>
              <div className="w-full h-full flex flex-1 flex-col px-6 py-5">
                <HomePage onNavigate={handleNavigate} search={search} />
              </div>
            </div>

            {isAppVisible && (
              <div
                className={`app-sheet phase-${phase} flex flex-col`}
                style={{ transformOrigin: originStyle }}
              >
                <div className="flex flex-1 flex-col overflow-auto scrollable-content">
                  <div className="w-full flex flex-1 flex-col gap-2 px-5 container-fluid mx-auto py-5">
                    {renderPage(activePage)}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="p-2 text-center text-xs text-muted-foreground border-t">
            <div className="flex items-center justify-center gap-2">
              <AccessMode />
              <BuildLabel />
            </div>
          </div>

          <Toaster />
          <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
          <ReleaseNotesModal open={releaseNotesOpen} onClose={() => setReleaseNotesOpen(false)} />

          <UpdateIndicator
            info={updateInfo}
            onRestart={installUpdate}
          />

        </div>
      </SidebarProvider>
      </TooltipProvider>
      </SettingsProvider>
    </ThemeProvider>
  );
}