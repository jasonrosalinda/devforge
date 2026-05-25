import { SiBlazor } from "react-icons/si";
import BlazorCheatsheet from "@/components/cheatsheets/blazor-cheatsheet";
import { PageHeader } from "@/components/layout/page-header";

export default function BlazorCheatsheetPage() {
    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                icon={SiBlazor}
                title="Blazor Cheatsheet"
                subtitle="Quick reference for Blazor components, lifecycle, parameters, and data binding."
            />
            <BlazorCheatsheet />
        </div>
    )
}
