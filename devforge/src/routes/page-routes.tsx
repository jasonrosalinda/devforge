import type { Page, PageGroup } from "@/types/pages.types";
import { Activity, Gauge, Languages, LayoutDashboard, Rocket, ScanSearch } from "lucide-react";

import HomePage from "@/pages/homePage";
import LocalizationPage from "@/pages/localizationPage";
import PageSpeedResultPage from "@/pages/pagespeedResultPage";
import UnusedAssetsPage from "@/pages/unusedAssetsPage";
import AppHealthCheckPage from "@/pages/appHealthCheckPage";
import ReleasePilotPage from "@/pages/releasePilotPage";
import { createToolboxToolPage } from "@/pages/toolboxToolPage";
import { TOOLBOX_TOOLS } from "@/components/toolbox/toolbox-registry";

export const HOME_PAGE = "Home";

/** Sidebar section order. */
export const PAGE_GROUPS: PageGroup[] = ["Monitoring", "Web quality", "Release", "Utilities"];

export const pages: Page[] = [
    {
        title: HOME_PAGE,
        url: "#",
        icon: LayoutDashboard,
        component: HomePage
    },
    {
        title: "App Health Check",
        url: "#",
        icon: Activity,
        component: AppHealthCheckPage,
        description: "Azure App Service CPU, memory, requests and downtime",
        group: "Monitoring"
    },
    {
        title: "PageSpeed",
        url: "#",
        icon: Gauge,
        component: PageSpeedResultPage,
        description: "Lighthouse audits across desktop and mobile, with branch comparison",
        group: "Web quality"
    },
    {
        title: "Unused Assets",
        url: "#",
        icon: ScanSearch,
        component: UnusedAssetsPage,
        description: "Scan a project for unused CSS classes/ids and JS functions",
        group: "Web quality"
    },
    {
        title: "Release Pilot",
        url: "#",
        icon: Rocket,
        component: ReleasePilotPage,
        description: "Load a Confluence deployment runbook with its screenshots",
        group: "Release"
    },
    {
        title: "Translation",
        url: "#",
        icon: Languages,
        component: LocalizationPage,
        description: "Browse and edit localization keys across languages",
        group: "Utilities"
    },
    // Each Toolbox utility is its own page (own sidebar item and tab), listed under Utilities.
    ...TOOLBOX_TOOLS.map((tool): Page => ({
        title: tool.title,
        url: "#",
        icon: tool.icon,
        component: createToolboxToolPage(tool),
        description: tool.description,
        group: "Utilities",
        keywords: tool.keywords
    }))
]

export function findPage(pageTitle: string): Page | undefined {
    return pages.find((page) => page.title === pageTitle);
}

/** Title/keyword match used by the sidebar search and the home cards. */
export function matchesPageSearch(page: Page, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return page.title.toLowerCase().includes(q)
        || (page.description?.toLowerCase().includes(q) ?? false)
        || (page.keywords?.some((keyword) => keyword.includes(q)) ?? false);
}

export function renderPage(pageTitle: string) {
    const page = findPage(pageTitle);
    if (!page) return null;

    const Component = page.component;
    return <Component />;
}
