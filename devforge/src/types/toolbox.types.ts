import type { ElementType } from "react";

/**
 * One tab in the Toolbox. Mirrors the Page registry in @/routes/page-routes so
 * adding a utility is an import plus one array entry.
 */
export type ToolboxTool = {
    /** Stable key; also what is remembered as the last open tab. */
    id: string;
    label: string;
    icon: ElementType;
    description: string;
    component: React.FC;
};
