import type { Page } from "@/types/pages.types";
import { BarChart, DatabaseZap, Eclipse, Image, Languages } from "lucide-react";
import { SiAmazonelasticache, SiPagespeedinsights, SiCss3, SiReact, SiBlazor } from "react-icons/si";
import { AiOutlineTranslation, AiOutlineFileImage } from "react-icons/ai";

import LocalizationPage from "@/pages/localizationPage";
import PageSpeedResultPage from "@/pages/pagespeedResultPage";
import MEDUCachePage from "@/pages/meduCachePage";
import CSSAuditPage from "@/pages/cssAuditPage";
import ImageToSvgConverter from "@/components/converters/img-to-svg-converter";
import ReactCheatsheetPage from "@/pages/reactCheatsheetPage";
import BlazorCheatsheetPage from "@/pages/blazorCheatsheetPage";

export const pages: Page[] = [
    {
        title: "Translation",
        url: "#",
        icon: AiOutlineTranslation,
        component: LocalizationPage
    },
    {
        title: "PageSpeed",
        url: "#",
        icon: SiPagespeedinsights,
        component: PageSpeedResultPage
    },
    {
        title: "MEDU Cache",
        url: "#",
        icon: SiAmazonelasticache,
        component: MEDUCachePage
    },
    {
        title: "CSS Audit",
        url: "#",
        icon: SiCss3,
        component: CSSAuditPage
    },
    {
        title: "Image to SVG",
        url: "#",
        icon: AiOutlineFileImage,
        component: ImageToSvgConverter
    },
    {
        title: "React Cheatsheet",
        url: "#",
        icon: SiReact,
        component: ReactCheatsheetPage
    },
    {
        title: "Blazor Cheatsheet",
        url: "#",
        icon: SiBlazor,
        component: BlazorCheatsheetPage
    }
]

export function renderPage(pageTitle: string) {
    const page = pages.find((page) => page.title === pageTitle);
    if (!page) return null;

    const Component = page.component;
    return <Component />;
}