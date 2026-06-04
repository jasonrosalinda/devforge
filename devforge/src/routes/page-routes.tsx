import type { Page } from "@/types/pages.types";
import { BarChart, Clock, DatabaseZap, Eclipse, Home, Image, Languages, Rocket } from "lucide-react";
import { SiPagespeedinsights, SiCss3, SiReact, SiBlazor } from "react-icons/si";
import { AiOutlineTranslation, AiOutlineFileImage } from "react-icons/ai";
import { TbActivity } from "react-icons/tb";

import HomePage from "@/pages/homePage";
import LocalizationPage from "@/pages/localizationPage";
import PageSpeedResultPage from "@/pages/pagespeedResultPage";
import CSSAuditPage from "@/pages/cssAuditPage";
import ImageToSvgPage from "@/pages/imageToSvgPage";
import ReactCheatsheetPage from "@/pages/reactCheatsheetPage";
import BlazorCheatsheetPage from "@/pages/blazorCheatsheetPage";
import TimeConverterPage from "@/pages/timeConverterPage";
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
        title: "App Health Check",
        url: "#",
        icon: TbActivity,
        component: AppHealthCheckPage
    },
    {
        title: "Release Pilot",
        url: "#",
        icon: Rocket,
        component: ReleasePilotPage
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
        component: ImageToSvgPage
    },
    {
        title: "Time Converter",
        url: "#",
        icon: Clock,
        component: TimeConverterPage
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