import { PageHeader } from "@/components/layout/page-header";
import type { ToolboxTool } from "@/types/toolbox.types";

/**
 * Wraps one Toolbox utility as a standalone page. Called once per tool at module
 * load (page-routes), so each page keeps a stable component identity.
 */
export function createToolboxToolPage(tool: ToolboxTool): React.FC {
    const Tool = tool.component;
    const ToolboxToolPage = () => (
        <div className="flex flex-col gap-4 h-full min-h-0">
            <PageHeader icon={tool.icon} title={tool.title} subtitle={tool.description} />
            {/* Same box the tools had inside the old Toolbox TabsContent. */}
            <div className="flex-1 min-h-0">
                <Tool />
            </div>
        </div>
    );
    ToolboxToolPage.displayName = `ToolboxToolPage(${tool.id})`;
    return ToolboxToolPage;
}
