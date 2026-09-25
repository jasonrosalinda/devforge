import type { LucideIcon } from "lucide-react";

/**
 * One Toolbox utility. Each becomes its own page (sidebar item + tab), so adding
 * a utility is an import plus one array entry in toolbox-registry.
 */
export type ToolboxTool = {
    /** Stable key. */
    id: string;
    /** Page title: shown in the sidebar, the tab and the page header. */
    title: string;
    icon: LucideIcon;
    description: string;
    component: React.FC;
    /** Extra search terms for the sidebar search. */
    keywords: string[];
};
