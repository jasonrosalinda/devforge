import type { Page } from "@/types/pages.types";
import { Home, Rocket, ScanSearch } from "lucide-react";
import { SiPagespeedinsights } from "react-icons/si";
import { AiOutlineTranslation } from "react-icons/ai";
import { TbActivity } from "react-icons/tb";

import HomePage from "@/pages/homePage";
import LocalizationPage from "@/pages/localizationPage";
import PageSpeedResultPage from "@/pages/pagespeedResultPage";
import UnusedAssetsPage from "@/pages/unusedAssetsPage";
import AppHealthCheckPage from "@/pages/appHealthCheckPage";
import ReleasePilotPage from "@/pages/releasePilotPage";

export const pages: Page[] = [
    {
        title: "Home",
        url: "#",
        icon: Home,
        component: HomePage
    },
    {
        title: "App Health Check",
        url: "#",
        icon: TbActivity,
        component: AppHealthCheckPage
    },
    {
        title: "PageSpeed",
        url: "#",
        icon: SiPagespeedinsights,
        component: PageSpeedResultPage
    },
    {
        title: "Unused Assets",
        url: "#",
        icon: ScanSearch,
        component: UnusedAssetsPage
    },
    {
        title: "Release Pilot",
        url: "#",
        icon: Rocket,
        component: ReleasePilotPage
    },
    {
        title: "Translation",
        url: "#",
        icon: AiOutlineTranslation,
        component: LocalizationPage
    }
]

export function renderPage(pageTitle: string) {
    const page = pages.find((page) => page.title === pageTitle);
    if (!page) return null;

    const Component = page.component;
    return <Component />;
}
