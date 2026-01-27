import type { Page } from "@/types/pages.types";
import { BarChart, DatabaseZap, Eclipse, Image, Languages } from "lucide-react";

import LocalizationPage from "@/pages/localizationPage";
import PageSpeedResultPage from "@/pages/pagespeedResultPage";
import MEDUCachePage from "@/pages/meduCachePage";
import CSSAuditPage from "@/pages/cssAuditPage";
import ImageToSvgConverter from "@/components/converters/img-to-svg-converter";
import ReactCheatsheet from "@/components/cheatsheets/react-cheatsheet";

export const pages: Page[] = [
    {
        title: "Translation",
        url: "#",
        icon: Languages,
        component: LocalizationPage
    },
    {
        title: "PageSpeed",
        url: "#",
        icon: BarChart,
        component: PageSpeedResultPage
    },
    {
        title: "MEDU Cache",
        url: "#",
        icon: DatabaseZap,
        component: MEDUCachePage
    },
    {
        title: "CSS Audit",
        url: "#",
        icon: Eclipse,
        component: CSSAuditPage
    },
    {
        title: "Image to SVG",
        url: "#",
        icon: Image,
        component: ImageToSvgConverter
    },
    {
        title: "React Cheatsheet",
        url: "#",
        icon: Image,
        component: ReactCheatsheet
    }
]

export function renderPage(pageTitle: string) {
    const page = pages.find((page) => page.title === pageTitle);
    if (!page) return null;

    const Component = page.component;
    return <Component />;
}