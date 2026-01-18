import { useState } from "react";
import Sidebar from "./components/layout/Sidebar";
import Header from "./components/layout/Header";
import Localization from "./pages/Localization";
import PageSpeedInsight from "./pages/PageSpeedInsight";

import { ToastProvider } from "./components/ui/contexts/ToastContext";
import { ConfirmDialogProvider } from './components/ui/contexts/ConfirmDialogContext';

export default function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [activePage, setActivePage] = useState("Translation");

  // Render the active page component
  const renderPage = () => {
    switch (activePage) {
      case "Translation":
        return <Localization />;
      case "PageSpeed Insight":
        return <PageSpeedInsight />;
      default:
        return <Localization />;
    }
  };

  return (
    <ConfirmDialogProvider>
      <ToastProvider>
        <div className="flex h-screen bg-gray-100">
          <Sidebar
            isSidebarOpen={isSidebarOpen}
            setIsSidebarOpen={setIsSidebarOpen}
            activePage={activePage}
            setActivePage={setActivePage}
          />

          <div className="flex-1 flex flex-col overflow-hidden">
            <Header activePage={activePage} />

            <main className="flex-1 overflow-y-auto p-6">
              <div className="max-w-7xl mx-auto">{renderPage()}</div>
            </main>
          </div>
        </div>
      </ToastProvider>
    </ConfirmDialogProvider>
  );
}
