import { Wrench } from "lucide-react";
import Toolbox from "@/components/toolbox/toolbox";
import { PageHeader } from "@/components/layout/page-header";

export default function ToolboxPage() {
    return (
        <div className="flex flex-col gap-4 h-full min-h-0">
            <PageHeader
                icon={Wrench}
                title="Toolbox"
                subtitle="Everyday developer utilities. Everything runs locally — nothing is sent anywhere."
            />
            <Toolbox />
        </div>
    )
}
