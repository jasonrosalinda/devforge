import type { LucideIcon } from "lucide-react";

export type PageGroup = "Monitoring" | "Web quality" | "Release" | "Utilities";

export type Page = {
    title: string;
    url?: string;
    icon: LucideIcon;
    component: React.FC;
    /** One line shown on the home cards and in the collapsed-sidebar tooltip. */
    description?: string;
    /** Sidebar section the page is listed under. Home has none and is pinned first. */
    group?: PageGroup;
    /** Extra terms the launcher search matches, for pages whose title alone is not findable. */
    keywords?: string[];
}
